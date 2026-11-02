// Gazebo-side deadman: if the ROS bridge/gateway dies, DiffDrive receives zero.
#include <chrono>
#include <gz/msgs/twist.pb.h>
#include <gz/plugin/Register.hh>
#include <gz/sim/System.hh>
#include <gz/transport/Node.hh>
#include <mutex>

namespace lattice {
class SimWatchdog final : public gz::sim::System,
                          public gz::sim::ISystemConfigure,
                          public gz::sim::ISystemPreUpdate {
public:
  void Configure(const gz::sim::Entity &,
                 const std::shared_ptr<const sdf::Element> &,
                 gz::sim::EntityComponentManager &,
                 gz::sim::EventManager &) override {
    publisher_ = node_.Advertise<gz::msgs::Twist>("/motor_cmd_vel");
    node_.Subscribe("/cmd_vel", &SimWatchdog::receive, this);
  }
  void PreUpdate(const gz::sim::UpdateInfo &,
                 gz::sim::EntityComponentManager &) override {
    const auto now = std::chrono::steady_clock::now();
    if (now - published_ < std::chrono::milliseconds(20))
      return;
    published_ = now;
    std::lock_guard<std::mutex> lock(mutex_);
    gz::msgs::Twist safe;
    if (now - received_ < std::chrono::milliseconds(250))
      safe = command_;
    publisher_.Publish(safe);
  }

private:
  void receive(const gz::msgs::Twist &command) {
    std::lock_guard<std::mutex> lock(mutex_);
    command_ = command;
    received_ = std::chrono::steady_clock::now();
  }
  gz::transport::Node node_;
  gz::transport::Node::Publisher publisher_;
  std::mutex mutex_;
  gz::msgs::Twist command_;
  std::chrono::steady_clock::time_point received_{}, published_{};
};
} // namespace lattice
GZ_ADD_PLUGIN(lattice::SimWatchdog, gz::sim::System, gz::sim::ISystemConfigure,
              gz::sim::ISystemPreUpdate)
