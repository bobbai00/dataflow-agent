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
"""Bubblewrap isolation for model-written code: Script ReAct's agent process, the engine's Python workers
(engine_python.py, the stack's UDF_PYTHON_PATH) and LongDS's smolagents interpreter.

engine_python.py runs as a script on the system Python and imports isolation.py as a sibling module; neither imports
anything else of bobbench."""
