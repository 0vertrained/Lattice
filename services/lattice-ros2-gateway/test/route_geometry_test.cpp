#include "route_geometry.hpp"
#include <limits>
#include <stdexcept>
void require(bool value) {
  if (!value) throw std::runtime_error("signed route region invariant failed");
}
int main() {
  lattice::RouteRegion target{1, -2, 0, 0.05};
  target.validate();
  require(target.contains(1.02, -2));
  // Nav2 can succeed within 20cm; a reviewed 5cm region must still reject it.
  require(!target.contains(1.15, -2));
  require(!target.contains(std::numeric_limits<double>::quiet_NaN(), -2));
  for (auto invalid : {lattice::RouteRegion{1, -2, 0.15, 0.4},
                       lattice::RouteRegion{1, -2, 0, 0.01}}) {
    bool rejected = false;
    try { invalid.validate(); } catch (const std::runtime_error &) { rejected = true; }
    require(rejected);
  }
}
