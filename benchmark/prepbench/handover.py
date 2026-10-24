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
"""Which operator each expected output file is exported from, besides the mapping the reply gives."""
from pathlib import Path


def files_named_like_operators(expected, mapping, results):
    """Expected output files the reply's mapping leaves out, each mapped to the operator named exactly like the file
    (output_01.csv -> output_01) when that operator has a stored result. smolagents' outputs are the files it wrote,
    whatever its last message says; an operator named like the file is the dataflow agent's equivalent."""
    named = {Path(name).name for name in mapping}
    return {file: Path(file).stem for file in expected if file not in named and Path(file).stem in results}
