# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Portable common model-request limits; generation settings are independent."""

import math

DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS = 240
MAX_MODEL_REQUEST_TIMEOUT_MILLISECONDS = 2_147_483_647


def validate_model_request_timeout_seconds(value):
    """Use the same positive integer millisecond domain as the native API."""
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise ValueError("model_request_timeout_seconds must be positive seconds with integer millisecond precision")
    if not 0.001 <= value <= MAX_MODEL_REQUEST_TIMEOUT_MILLISECONDS / 1000:
        raise ValueError(
            "model_request_timeout_seconds must be positive seconds with integer millisecond precision within portable timer range"
        )
    milliseconds = round(value * 1000)
    if value != milliseconds / 1000:
        raise ValueError(
            "model_request_timeout_seconds must be positive seconds with integer millisecond precision within portable timer range"
        )
    return value
