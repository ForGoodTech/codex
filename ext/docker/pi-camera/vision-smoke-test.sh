#!/bin/bash
set -euo pipefail

python3 - <<'PY'
import os

import cv2
import ncnn
import numpy as np


bgr = np.array(
    [
        [[0, 0, 0], [255, 255, 255]],
        [[0, 0, 255], [255, 0, 0]],
    ],
    dtype=np.uint8,
)
gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
np.testing.assert_array_equal(
    gray,
    np.array([[0, 255], [76, 29]], dtype=np.uint8),
)
centered = np.ascontiguousarray(gray, dtype=np.float32).reshape(-1) - 100.0
expected = np.maximum(centered, 0.0)

param = """7767517
2 2
Input data 0 1 data
ReLU relu 1 1 data output
"""

with ncnn.Net() as net:
    if net.load_param_mem(param) != 0:
        raise RuntimeError("NCNN failed to load the smoke-test network")
    if net.load_model(ncnn.DataReaderFromEmpty()) != 0:
        raise RuntimeError("NCNN failed to initialize the smoke-test network")

    # ReLU may operate in place, so give NCNN an owned tensor rather than a
    # zero-copy view over the NumPy array.
    input_mat = ncnn.Mat(centered).clone()
    with net.create_extractor() as extractor:
        if extractor.input("data", input_mat) != 0:
            raise RuntimeError("NCNN rejected the OpenCV-derived input tensor")
        status, output_mat = extractor.extract("output")
        if status != 0:
            raise RuntimeError(f"NCNN inference failed with status {status}")
        actual = np.array(output_mat, copy=True).reshape(-1)

np.testing.assert_allclose(actual, expected)

expected_ncnn_version = os.environ.get("NCNN_VERSION")
if expected_ncnn_version and not ncnn.__version__.endswith(expected_ncnn_version):
    raise RuntimeError(
        f"Expected NCNN release {expected_ncnn_version}, found {ncnn.__version__}"
    )

if os.environ.get("NCNN_VULKAN", "OFF") == "ON":
    if not hasattr(ncnn, "get_gpu_count"):
        raise RuntimeError("NCNN_VULKAN=ON but the Python module lacks Vulkan support")
    print(f"NCNN Vulkan devices visible: {ncnn.get_gpu_count()}")

print(f"OpenCV {cv2.__version__}")
print(f"NCNN {ncnn.__version__}")
print("OpenCV-to-NCNN vision smoke test passed")
PY
