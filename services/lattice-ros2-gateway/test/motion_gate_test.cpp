#include "motion_gate.hpp"
#include <limits>
#include <stdexcept>
void require(bool condition) {
  if (!condition)
    throw std::runtime_error("motion gate invariant failed");
}
int main() {
  using namespace std::chrono_literals;
  using Gate = lattice::MotionGate;
  const auto now = Gate::Clock::now();
  Gate gate;
  require(!gate.start(now, 10000, 0.3));
  gate.lease(now);
  gate.pose(now);
  require(!gate.start(now, 10000, std::numeric_limits<double>::quiet_NaN()));
  require(gate.start(now, 10000, 0.3));
  require(!gate.start(now, 10000, 0.3));
  require(gate.linear(1.0, now) == 0.3);
  require(gate.linear(std::numeric_limits<double>::infinity(), now) == 0);
  require(gate.linear(0.3, now + 501ms) == 0);
  gate.pose(now + 1600ms);
  require(gate.fault(now + 1600ms) == "core/body connection watchdog");
  require(gate.linear(0.3, now + 1600ms) == 0);
  gate.lease(now + 1600ms);
  gate.estop(true);
  require(gate.linear(0.3, now + 1600ms) == 0);
  gate.estop(false);
  require(gate.linear(0.3, now + 1600ms) ==
          0); // Clearing stop never resumes a goal.
  require(gate.start(now + 1600ms, 100, 0.3));
  require(gate.linear(0.3, now + 1700ms) == 0);
  return 0;
}
