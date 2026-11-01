#include <chrono>
#include <memory>
#include <string>

#include "rclcpp/rclcpp.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"

namespace lattice {

class GatewayNode final : public rclcpp_lifecycle::LifecycleNode {
 public:
  explicit GatewayNode(const rclcpp::NodeOptions& options)
      : rclcpp_lifecycle::LifecycleNode("lattice_ros2_gateway", options) {
    declare_parameter<std::string>("body_id", "");
    declare_parameter<int>("command_watchdog_ms", 250);
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State&) override {
    const auto body_id = get_parameter("body_id").as_string();
    if (body_id.empty()) {
      RCLCPP_ERROR(get_logger(), "body_id is required");
      return CallbackReturn::FAILURE;
    }

    // This timer proves lifecycle and health behavior without exposing an
    // actuator path. Typed command transport is added behind a reviewed adapter.
    health_timer_ = create_wall_timer(std::chrono::seconds(1), [this, body_id]() {
      RCLCPP_DEBUG(get_logger(), "gateway healthy for body=%s", body_id.c_str());
    });
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State&) override {
    RCLCPP_INFO(get_logger(), "Lattice ROS 2 gateway activated");
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State&) override {
    RCLCPP_WARN(get_logger(), "gateway deactivated; local safety must stop motion");
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State&) override {
    health_timer_.reset();
    return CallbackReturn::SUCCESS;
  }

 private:
  rclcpp::TimerBase::SharedPtr health_timer_;
};

}  // namespace lattice

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);
  const auto node = std::make_shared<lattice::GatewayNode>(rclcpp::NodeOptions{});
  rclcpp::spin(node->get_node_base_interface());
  rclcpp::shutdown();
  return 0;
}
