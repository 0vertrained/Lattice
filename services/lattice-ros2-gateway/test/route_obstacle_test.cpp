#include "route_obstacle.hpp"
#include <stdexcept>
void require(bool value) {
  if (!value) throw std::runtime_error("route obstacle invariant failed");
}
int main() {
  using lattice::corridor_blockage;
  std::vector<float> scan{0.7f, 0.7f, 0.7f};
  auto blocked = corridor_blockage(0, 0, 2, 0, 0, 0, 0, -.02, .02, .08, 12, scan);
  require(blocked && blocked->samples == 3 && blocked->distance_m < .71);
  // Body heading does not determine the selected route's bearing.
  require(corridor_blockage(1, 2, 1, 0, 1, 2, -1.57079632679,
                           -.02, .02, .08, 12, scan).has_value());
  // Nearby returns outside the selected detour corridor cannot close that edge.
  require(!corridor_blockage(0, 0, 0, 2, 0, 0, 0, -.02, .02, .08, 12, scan));
  require(!corridor_blockage(0, 0, -2, 0, 0, 0, 0, -.02, .02, .08, 12, scan));
  require(!corridor_blockage(0, 0, .4, 0, 0, 0, 0, -.02, .02, .08, 12, scan));
  scan[1] = std::numeric_limits<float>::infinity();
  require(!corridor_blockage(0, 0, 2, 0, 0, 0, 0, -.02, .02, .08, 12, scan));
  scan[1] = std::numeric_limits<float>::quiet_NaN();
  require(!corridor_blockage(0, 0, 2, 0, 0, 0, 0, -.02, .02, .08, 12, scan));
}
