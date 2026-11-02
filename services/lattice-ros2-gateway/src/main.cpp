#include "geometry_msgs/msg/twist.hpp"
#include "lifecycle_msgs/msg/state.hpp"
#include "lifecycle_msgs/msg/transition.hpp"
#include "lifecycle_msgs/srv/get_state.hpp"
#include "motion_gate.hpp"
#include "route_geometry.hpp"
#include "route_obstacle.hpp"
#include "nav2_msgs/action/navigate_to_pose.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_action/rclcpp_action.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "sensor_msgs/msg/image.hpp"
#include "sensor_msgs/msg/laser_scan.hpp"
#include "std_msgs/msg/bool.hpp"
#include "tf2_ros/buffer.h"
#include "tf2_ros/transform_listener.h"
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

using namespace std::chrono_literals;
namespace lattice {
using Json = nlohmann::json;
using Navigate = nav2_msgs::action::NavigateToPose;
using Handle = rclcpp_action::ClientGoalHandle<Navigate>;
class FileDescriptor {
public:
  explicit FileDescriptor(int fd = -1) : value_(fd) {}
  ~FileDescriptor() { reset(); }
  FileDescriptor(const FileDescriptor &) = delete;
  FileDescriptor &operator=(const FileDescriptor &) = delete;
  int get() const { return value_; }
  void reset(int fd = -1) {
    if (value_ >= 0)
      ::close(value_);
    value_ = fd;
  }

private:
  int value_;
};

class GatewayNode final : public rclcpp_lifecycle::LifecycleNode {
public:
  GatewayNode() : rclcpp_lifecycle::LifecycleNode("lattice_ros2_gateway") {
    declare_parameter("socket_path", "/run/lattice/gateway.sock");
    declare_parameter("map_frame_id", "map");
    declare_parameter("base_frame_id", "base_link");
    declare_parameter("locations_file",
                      "/opt/lattice/warehouse/locations.json");
  }
  ~GatewayNode() override {
    if (owns_socket_)
      std::filesystem::remove(socket_path_);
  }
  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override {
    try {
      std::ifstream locations(get_parameter("locations_file").as_string());
      locations >> locations_;
      socket_path_ = get_parameter("socket_path").as_string();
      if (socket_path_.size() >= sizeof(sockaddr_un::sun_path))
        throw std::runtime_error("socket path too long");
      std::filesystem::create_directories(
          std::filesystem::path(socket_path_).parent_path());
      listener_.reset(
          ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0));
      if (listener_.get() < 0)
        throw std::runtime_error("socket creation failed");
      sockaddr_un address{};
      address.sun_family = AF_UNIX;
      std::memcpy(address.sun_path, socket_path_.c_str(),
                  socket_path_.size() + 1);
      if (::bind(listener_.get(), reinterpret_cast<sockaddr *>(&address),
                 sizeof(address)) < 0)
        throw std::runtime_error(
            "socket bind failed; check for another gateway or stale socket");
      owns_socket_ = true;
      if (::chmod(socket_path_.c_str(), 0600) < 0 ||
          ::listen(listener_.get(), 4) < 0)
        throw std::runtime_error("cannot protect/listen on local socket");
      nav_ = rclcpp_action::create_client<Navigate>(this, "navigate_to_pose");
      nav_state_ = create_client<lifecycle_msgs::srv::GetState>(
          "bt_navigator/get_state");
      velocity_ = create_publisher<geometry_msgs::msg::Twist>("cmd_vel", 10);
      tf_ = std::make_unique<tf2_ros::Buffer>(get_clock());
      tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_);
      input_ = create_subscription<geometry_msgs::msg::Twist>(
          "cmd_vel_nav", 10,
          [this](geometry_msgs::msg::Twist::ConstSharedPtr msg) {
            desired_ = *msg;
            velocity_at_ = MotionGate::Clock::now();
          });
      camera_ = create_subscription<sensor_msgs::msg::Image>(
          "camera/image", rclcpp::SensorDataQoS(),
          [this](sensor_msgs::msg::Image::ConstSharedPtr msg) {
            if (msg->width == 320 && msg->height == 240 &&
                msg->encoding == "rgb8" && msg->step == 960 &&
                msg->data.size() == 230400) {
              frame_ = msg;
              frame_at_ = MotionGate::Clock::now();
              frame_unix_ms_ =
                  std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::system_clock::now().time_since_epoch())
                      .count();
            }
          });
      scan_subscription_ = create_subscription<sensor_msgs::msg::LaserScan>(
          "scan", rclcpp::SensorDataQoS(),
          [this](sensor_msgs::msg::LaserScan::ConstSharedPtr msg) {
            if (!msg->ranges.empty() && msg->ranges.size() <= 720 &&
                !msg->header.frame_id.empty() && msg->header.frame_id.size() <= 80 &&
                std::isfinite(msg->angle_min) && std::isfinite(msg->angle_increment) &&
                msg->angle_increment > 0 && std::isfinite(msg->range_min) &&
                std::isfinite(msg->range_max) && msg->range_min > 0 &&
                msg->range_max > msg->range_min && msg->range_max <= 100) {
              scan_ = msg;
              scan_at_ = MotionGate::Clock::now();
              scan_unix_ms_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::system_clock::now().time_since_epoch()).count();
            } else {
              scan_.reset();
            }
          });
      estop_ = create_subscription<std_msgs::msg::Bool>(
          "lattice/emergency_stop", 10,
          [this](std_msgs::msg::Bool::ConstSharedPtr msg) {
            gate_.estop(msg->data);
            if (msg->data)
              stop("emergency stop");
          });
      return CallbackReturn::SUCCESS;
    } catch (const std::exception &error) {
      RCLCPP_ERROR(get_logger(), "%s", error.what());
      return CallbackReturn::FAILURE;
    }
  }
  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override {
    velocity_->on_activate();
    timer_ = create_wall_timer(20ms, [this] { tick(); });
    return CallbackReturn::SUCCESS;
  }
  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override {
    stop("gateway deactivated");
    timer_.reset();
    velocity_->on_deactivate();
    return CallbackReturn::SUCCESS;
  }

private:
  void stop(const std::string &reason) {
    const bool had_goal = state_ == "running";
    gate_.stop();
    desired_ = geometry_msgs::msg::Twist{};
    if (velocity_->is_activated())
      velocity_->publish(geometry_msgs::msg::Twist{});
    if (goal_) {
      nav_->async_cancel_goal(goal_);
      goal_.reset();
    }
    if (had_goal) {
      state_ = "failed";
      detail_ = reason;
    }
  }
  bool ready() const {
    return nav_active_ && MotionGate::Clock::now() - nav_state_at_ < 1500ms &&
           nav_->action_server_is_ready() && !pose_.is_null() &&
           !gate_.emergency_stopped();
  }
  Json status(bool ok = true) const {
    return {{"ok", ok},
            {"ready", ready()},
            {"state", state_},
            {"command_id", command_id_},
            {"detail", detail_},
            {"pose", pose_},
            {"progress_pct", progress_},
            {"route_observation", route_observation_}};
  }
  Json request(const Json &data) {
    const auto now = MotionGate::Clock::now();
    const auto op = data.at("op").get<std::string>();
    if (op == "status")
      return status();
    if (op == "lease") {
      gate_.lease(now);
      return status();
    }
    if (op == "stop") {
      stop("body agent stopped");
      return status();
    }
    if (op == "capture") {
      if (state_ != "succeeded" || !inspection_ ||
          data.at("command_id").get<std::string>() != command_id_ || !frame_ ||
          now - frame_at_ > 500ms || frame_at_ <= arrived_at_ ||
          rclcpp::Time(frame_->header.stamp) <= arrived_sim_ ||
          (this->now() - rclcpp::Time(frame_->header.stamp)).seconds() > 0.5)
        throw std::runtime_error(
            "fresh post-arrival camera frame not available");
      const auto filename = command_id_ + ".ppm";
      const auto path =
          std::filesystem::path(socket_path_).parent_path() / filename;
      std::ofstream file(path, std::ios::binary);
      file << "P6\n320 240\n255\n";
      file.write(reinterpret_cast<const char *>(frame_->data.data()),
                 frame_->data.size());
      file.close();
      if (!file)
        throw std::runtime_error("camera capture write failed");
      auto result = status();
      result["capture_file"] = filename;
      result["capture_unix_ms"] = frame_unix_ms_;
      return result;
    }
    if (op != "navigate" && op != "traverse_route")
      throw std::runtime_error("unknown local operation");
    if (state_ == "running")
      throw std::runtime_error("navigation already active");
    const auto destination = data.at("destination").get<std::string>();
    if (!ready())
      throw std::runtime_error("navigation/localization not ready");
    const auto speed = data.at("max_speed_mps").get<double>();
    Json target;
    std::optional<RouteRegion> arrival;
    if (op == "traverse_route") {
      if (!scan_ || now - scan_at_ > 300ms)
        throw std::runtime_error("fresh laser scan required before route traversal");
      const auto &route = data.at("traversal");
      const auto &from = route.at("from");
      const auto &to = route.at("to");
      const auto &requirements = route.at("required_capabilities");
      if (!requirements.is_array() || requirements.size() != 1 ||
          requirements.at(0) != "navigate" || to.at("id") != destination ||
          route.at("max_speed_mps").get<double>() != speed)
        throw std::runtime_error("rover cannot execute the requested route capabilities");
      const auto a = from.at("pose"), b = to.at("pose");
      const double ax = a.at("x"), ay = a.at("y"), az = a.at("z");
      const double bx = b.at("x"), by = b.at("y"), bz = b.at("z");
      const double radius = from.at("arrival_radius_m");
      const auto current = pose_;
      const RouteRegion source{ax, ay, az, radius};
      source.validate();
      arrival = RouteRegion{bx, by, bz, to.at("arrival_radius_m")};
      arrival->validate();
      if (current.is_null() ||
          !source.contains(current.at("x"), current.at("y")))
        throw std::runtime_error("rover must start at the reviewed ground-level route source");
      target = {{"x", bx}, {"y", by}, {"yaw", std::atan2(by - ay, bx - ax)}};
    } else {
      if (!locations_.contains(destination))
        throw std::runtime_error("unknown warehouse destination");
      target = locations_.at(destination);
    }
    const auto utc_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
    const auto remaining = std::min<std::int64_t>(
        data.at("ttl_ms").get<std::int64_t>(),
        data.at("expires_unix_ms").get<std::int64_t>() - utc_ms);
    if (remaining <= 0 || remaining > 300000 ||
        !gate_.start(now, static_cast<int>(remaining), speed))
      throw std::runtime_error("local motion policy rejected command");
    const auto id_value = data.at("command_id").get<std::string>();
    if (id_value.empty() || id_value.size() > 80 ||
        id_value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
                                   "RSTUVWXYZ0123456789-_") !=
            std::string::npos) {
      gate_.stop();
      throw std::runtime_error("invalid command identity");
    }
    command_id_ = id_value;
    active_route_ = op == "traverse_route" ? data.at("traversal") : Json(nullptr);
    route_observation_ = nullptr;
    scan_transform_wait_at_.reset();
    inspection_ = data.value("inspection", false);
    state_ = "running";
    detail_ = "Nav2 goal requested";
    progress_ = 0;
    initial_distance_ = 0;
    Navigate::Goal message;
    message.pose.header.frame_id = get_parameter("map_frame_id").as_string();
    message.pose.header.stamp = this->now();
    message.pose.pose.position.x = target.at("x");
    message.pose.pose.position.y = target.at("y");
    const double yaw = target.at("yaw");
    message.pose.pose.orientation.z = std::sin(yaw / 2);
    message.pose.pose.orientation.w = std::cos(yaw / 2);
    const auto id = command_id_;
    rclcpp_action::Client<Navigate>::SendGoalOptions options;
    options.goal_response_callback = [this,
                                      id](const Handle::SharedPtr &handle) {
      if (id != command_id_ || !gate_.active()) {
        if (handle)
          nav_->async_cancel_goal(handle);
        return;
      }
      if (!handle) {
        stop("Nav2 rejected the goal");
        return;
      }
      goal_ = handle;
      detail_ = "navigating";
    };
    options.feedback_callback =
        [this, id](Handle::SharedPtr,
                   const std::shared_ptr<const Navigate::Feedback> feedback) {
          if (id != command_id_ || !gate_.active())
            return;
          const double distance = feedback->distance_remaining;
          if (!std::isfinite(distance) || distance < 0)
            return;
          if (initial_distance_ == 0 && distance > 0.01)
            initial_distance_ = distance;
          if (initial_distance_ > 0)
            progress_ = std::clamp(
                static_cast<int>(100 * (1 - distance / initial_distance_)), 0,
                99);
        };
    options.result_callback = [this, id, arrival](const Handle::WrappedResult &result) {
      if (id != command_id_ || !gate_.active())
        return;
      gate_.stop();
      goal_.reset();
      desired_ = geometry_msgs::msg::Twist{};
      const bool in_region = !arrival ||
          (!pose_.is_null() && arrival->contains(pose_.at("x"), pose_.at("y")));
      if (result.code == rclcpp_action::ResultCode::SUCCEEDED && in_region) {
        state_ = "succeeded";
        arrived_at_ = MotionGate::Clock::now();
        arrived_sim_ = this->now();
        progress_ = 100;
        detail_ = "destination reached";
      } else {
        state_ = "failed";
        detail_ = in_region ? "Nav2 could not reach destination"
                            : "Nav2 stopped outside the reviewed arrival region";
      }
      velocity_->publish(geometry_msgs::msg::Twist{});
    };
    nav_->async_send_goal(message, options);
    return status();
  }
  void tick() {
    const auto wall = MotionGate::Clock::now();
    if (wall - nav_query_at_ >= 500ms) {
      nav_query_at_ = wall;
      nav_state_->prune_pending_requests();
      if (nav_state_->service_is_ready()) {
        nav_state_->async_send_request(
            std::make_shared<lifecycle_msgs::srv::GetState::Request>(),
            [this](rclcpp::Client<lifecycle_msgs::srv::GetState>::SharedFuture
                       response) {
              nav_active_ = response.get()->current_state.id ==
                            lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE;
              nav_state_at_ = MotionGate::Clock::now();
            });
      } else {
        nav_active_ = false;
      }
    }
    pose_ = nullptr;
    try {
      const auto tf =
          tf_->lookupTransform(get_parameter("map_frame_id").as_string(),
                               get_parameter("base_frame_id").as_string(),
                               tf2::TimePointZero);
      const double age = (now() - rclcpp::Time(tf.header.stamp)).seconds();
      if (age >= -0.1 && age < 0.5) {
        const auto &p = tf.transform.translation;
        const auto &q = tf.transform.rotation;
        const auto yaw = std::atan2(2 * (q.w * q.z + q.x * q.y),
                                    1 - 2 * (q.y * q.y + q.z * q.z));
        if (std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(yaw)) {
          pose_ = {{"x", p.x}, {"y", p.y}, {"yaw", yaw}};
          gate_.pose(wall);
        }
      }
    } catch (const tf2::TransformException
                 &) { /* Missing localization closes the motion gate. */
    }
    if (gate_.active() && !gate_.fault(wall).empty())
      stop(gate_.fault(wall));
    const bool route_observed_clear = !gate_.active() || active_route_.is_null() ||
                                     check_route_obstacle(wall);
    geometry_msgs::msg::Twist safe;
    if (wall - velocity_at_ < 300ms && gate_.active() &&
        gate_.fault(wall).empty() && route_observed_clear) {
      safe.linear.x = gate_.linear(desired_.linear.x, wall);
      safe.angular.z = std::isfinite(desired_.angular.z)
                           ? std::clamp(desired_.angular.z, -0.8, 0.8)
                           : 0;
    }
    velocity_->publish(safe);
    serve(wall);
  }
  bool check_route_obstacle(MotionGate::Time wall) {
    if (!scan_ || wall - scan_at_ > 300ms || pose_.is_null()) {
      stop("route laser/localization watchdog");
      return false;
    }
    const double age = (now() - rclcpp::Time(scan_->header.stamp)).seconds();
    if (age < -0.1 || age > 0.3) {
      stop("route laser timestamp watchdog");
      return false;
    }
    try {
      // Transform the measured rays at their own timestamp, not at a later
      // body heading; the route may start with the inspection camera facing away.
      const auto transform = tf_->lookupTransform(
          get_parameter("map_frame_id").as_string(), scan_->header.frame_id,
          rclcpp::Time(scan_->header.stamp));
      if (scan_transform_wait_at_)
        detail_ = "navigating after measured scan transform became available";
      scan_transform_wait_at_.reset();
      const auto &translation = transform.transform.translation;
      const auto &q = transform.transform.rotation;
      const double yaw = std::atan2(2 * (q.w * q.z + q.x * q.y),
                                    1 - 2 * (q.y * q.y + q.z * q.z));
      const auto &target = active_route_.at("to").at("pose");
      const auto blocked = corridor_blockage(
          pose_.at("x"), pose_.at("y"), target.at("x"), target.at("y"),
          translation.x, translation.y, yaw, scan_->angle_min,
          scan_->angle_increment, scan_->range_min, scan_->range_max, scan_->ranges);
      if (!blocked)
        return true;
      Json ranges = Json::array();
      for (const auto value : scan_->ranges)
        ranges.push_back(std::isfinite(value) ? Json(value) : Json(nullptr));
      route_observation_ = {
          {"command_id", command_id_},
          {"map_digest", active_route_.at("map_digest")},
          {"segment_id", active_route_.at("segment_id")},
          {"observed_unix_ms", scan_unix_ms_},
          {"observer_pose", pose_},
          {"distance_m", blocked->distance_m},
          {"blocked_samples", blocked->samples},
          {"scan", {{"sensor_frame_id", scan_->header.frame_id},
                    {"stamp_sec", scan_->header.stamp.sec},
                    {"stamp_nanosec", scan_->header.stamp.nanosec},
                    {"angle_min", scan_->angle_min},
                    {"angle_increment", scan_->angle_increment},
                    {"range_min", scan_->range_min},
                    {"range_max", scan_->range_max},
                    {"sensor_map_pose", {{"x", translation.x}, {"y", translation.y}, {"yaw", yaw}}},
                    {"ranges", ranges}}}};
      // Freeze evidence before withdrawing local motion; reporting to the core
      // happens later and can never delay this stop.
      stop("laser returns block the reviewed route corridor");
      return false;
    } catch (const tf2::TransformException &error) {
      // Scan and TF callbacks can arrive in different orders. Withhold every
      // motion output while waiting; use acquisition-time geometry only.
      if (!scan_transform_wait_at_) {
        scan_transform_wait_at_ = wall;
        detail_ = "waiting stopped for laser acquisition transform";
        RCLCPP_WARN(get_logger(), "Holding route while scan transform arrives: %s", error.what());
      }
      if (wall - *scan_transform_wait_at_ > 500ms)
        stop("route laser transform unavailable for 500 ms");
      return false;
    }
  }
  void serve(MotionGate::Time now) {
    if (client_.get() < 0) {
      client_.reset(::accept4(listener_.get(), nullptr, nullptr,
                              SOCK_NONBLOCK | SOCK_CLOEXEC));
      buffer_.clear();
      client_at_ = now;
    }
    if (client_.get() < 0)
      return;
    char bytes[4096];
    const auto count =
        ::recv(client_.get(), bytes, sizeof(bytes), MSG_DONTWAIT);
    if (count > 0)
      buffer_.append(bytes, static_cast<std::size_t>(count));
    else if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
      client_.reset();
      return;
    }
    if (buffer_.size() > 8192 || now - client_at_ > 200ms) {
      client_.reset();
      return;
    }
    if (buffer_.find('\n') == std::string::npos)
      return;
    Json response;
    try {
      response = request(Json::parse(buffer_));
    } catch (const std::exception &error) {
      response = status(false);
      response["detail"] = error.what();
    }
    const auto encoded = response.dump() + "\n";
    ::send(client_.get(), encoded.data(), encoded.size(),
           MSG_NOSIGNAL | MSG_DONTWAIT);
    client_.reset();
  }
  rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr camera_;
  rclcpp::Subscription<sensor_msgs::msg::LaserScan>::SharedPtr scan_subscription_;
  sensor_msgs::msg::LaserScan::ConstSharedPtr scan_;
  MotionGate::Time scan_at_{};
  std::optional<MotionGate::Time> scan_transform_wait_at_;
  std::int64_t scan_unix_ms_{0};
  Json active_route_ = nullptr, route_observation_ = nullptr;
  sensor_msgs::msg::Image::ConstSharedPtr frame_;
  MotionGate::Time frame_at_{}, arrived_at_{};
  std::int64_t frame_unix_ms_{0};
  bool inspection_{false};
  rclcpp::Time arrived_sim_{0, 0, RCL_ROS_TIME};
  Json locations_;
  Json pose_ = nullptr;
  std::string socket_path_, command_id_, state_{"idle"},
      detail_{"waiting for mission"}, buffer_;
  bool owns_socket_{false};
  int progress_{0};
  double initial_distance_{0};
  MotionGate gate_;
  MotionGate::Time velocity_at_{}, client_at_{};
  FileDescriptor listener_, client_;
  rclcpp::Client<lifecycle_msgs::srv::GetState>::SharedPtr nav_state_;
  bool nav_active_{false};
  MotionGate::Time nav_state_at_{}, nav_query_at_{};
  rclcpp_action::Client<Navigate>::SharedPtr nav_;
  Handle::SharedPtr goal_;
  rclcpp_lifecycle::LifecyclePublisher<geometry_msgs::msg::Twist>::SharedPtr
      velocity_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr input_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr estop_;
  geometry_msgs::msg::Twist desired_;
  std::unique_ptr<tf2_ros::Buffer> tf_;
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;
  rclcpp::TimerBase::SharedPtr timer_;
};
} // namespace lattice
int main(int argc, char *argv[]) {
  rclcpp::init(argc, argv);
  auto node = std::make_shared<lattice::GatewayNode>();
  node->trigger_transition(
      lifecycle_msgs::msg::Transition::TRANSITION_CONFIGURE);
  node->trigger_transition(
      lifecycle_msgs::msg::Transition::TRANSITION_ACTIVATE);
  if (node->get_current_state().id() !=
      lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    rclcpp::shutdown();
    return 1;
  }
  rclcpp::spin(node->get_node_base_interface());
  rclcpp::shutdown();
  return 0;
}
