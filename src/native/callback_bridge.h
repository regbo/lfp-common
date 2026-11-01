#pragma once

#include <Python.h>
#include <cstdint>

namespace pynect {

/** Create a Python callable backed by a registered JavaScript callback. */
PyObject* createPythonCallback(uint32_t callbackId);

} // namespace pynect
