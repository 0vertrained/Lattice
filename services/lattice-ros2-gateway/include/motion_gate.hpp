#pragma once
#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>

namespace lattice {
// Wall/steady time is deliberate: pausing Gazebo must not pause the watchdog.
class MotionGate {
public:
  using Clock = std::chrono::steady_clock;
  using Time = Clock::time_point;
  void lease(Time now) { lease_ = now; }
  void pose(Time now) { pose_ = now; }
  bool start(Time now, int ttl_ms, double speed) {
    if (active_ || estop_ || ttl_ms <= 0 || ttl_ms > 300000 ||
        !std::isfinite(speed) || speed < 0.05 || speed > 3.0 ||
        now - lease_ > std::chrono::milliseconds(1500) ||
        now - pose_ > std::chrono::milliseconds(500))
      return false;
    deadline_ = now + std::chrono::milliseconds(ttl_ms);
    speed_ = std::min(speed, 0.4);
    active_ = true;
    return true;
  }
  void stop() { active_ = false; }
  void estop(bool value) {
    estop_ = value;
    if (value)
      stop();
  }
  bool active() const { return active_; }
  bool emergency_stopped() const { return estop_; }
  std::string fault(Time now) const {
    if (estop_)
      return "emergency stop";
    if (now >= deadline_)
      return "signed command expired";
    if (now - lease_ > std::chrono::milliseconds(1500))
      return "core/body connection watchdog";
    if (now - pose_ > std::chrono::milliseconds(500))
      return "localization watchdog";
    return "";
  }
  double linear(double requested, Time now) const {
    if (!active_ || !fault(now).empty() || !std::isfinite(requested))
      return 0.0;
    return std::clamp(requested, -speed_, speed_);
  }

private:
  bool active_{false}, estop_{false};
  double speed_{0};
  Time lease_{}, pose_{}, deadline_{};
};
} // namespace lattice
