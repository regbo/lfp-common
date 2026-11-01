/**
 * pynect - GIL Guard Implementation
 * The GIL guard is header-only; this file provides explicit template
 * instantiations and any platform-specific workarounds.
 */

#include "gil_guard.h"

// All implementation is in the header file (RAII classes are trivial inline).
// This .cpp exists to satisfy the build system and future non-inline additions.

namespace pynect {

// Verify at compile time that our RAII types are not accidentally copied
static_assert(!std::is_copy_constructible<GILAcquire>::value,
              "GILAcquire must not be copy-constructible");
static_assert(!std::is_copy_constructible<GILRelease>::value,
              "GILRelease must not be copy-constructible");
static_assert(!std::is_copy_constructible<PyRef>::value,
              "PyRef must not be copy-constructible");

static_assert(std::is_move_constructible<PyRef>::value,
              "PyRef must be move-constructible");

} // namespace pynect
