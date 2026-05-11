#include "livemap/tile_math.hpp"

namespace livemap {

int floorDiv(int value, int divisor)
{
    int quotient = value / divisor;
    const int remainder = value % divisor;
    if (remainder != 0 && ((remainder < 0) != (divisor < 0))) {
        --quotient;
    }
    return quotient;
}

}  // namespace livemap
