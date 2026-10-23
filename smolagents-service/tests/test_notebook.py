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

import json
import tempfile
import unittest
from pathlib import Path

from smolagents_service.notebook import files_read, missing_files, read_notebook


def notebook_file(folder: Path, *cells: str) -> Path:
    path = folder / "work.ipynb"
    path.write_text(json.dumps({"cells": [{"cell_type": "code", "source": [cell]} for cell in cells]}))
    return path


class NotebookTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.files = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_ipython_lines_are_commented_out_only_where_needed(self):
        notebook = read_notebook(notebook_file(
            self.files, "%matplotlib inline\nimport pandas as pd\n!pip install seaborn",
            "label = ('%d rows'\n         % 3)",  # a line starting with % that is Python
            "%%bash\nls"))  # not Python either way: left to fail when it runs
        self.assertEqual(notebook.cells[0].code, "# %matplotlib inline\nimport pandas as pd\n# !pip install seaborn")
        self.assertEqual(notebook.cells[1].code, "label = ('%d rows'\n         % 3)")
        self.assertEqual(notebook.cells[2].code, "%%bash\nls")

    def test_the_files_a_notebook_reads(self):
        notebook = read_notebook(notebook_file(
            self.files,
            "import pandas as pd\nlistings = pd.read_csv('listings.csv', low_memory=False)\n"
            "notes = open('notes.txt').read()",
            "listings.to_csv('clean.csv')\nback = pd.read_csv('clean.csv')\n"  # written first, then read
            "with open('log.txt', 'w') as log:\n    log.write('x')",
            "q = pd.read_sql('SELECT a.b FROM t', connection)\nweb = pd.read_csv('https://example.com/a.csv')\n"
            "where = 'reviews.csv'\nreviews = pd.read_csv(where)\nold = pd.read_csv('../other/listings.csv')"))
        self.assertEqual(files_read(notebook), ["listings.csv", "notes.txt", "../other/listings.csv"])
        (self.files / "listings.csv").write_text("id\n1\n")
        self.assertEqual(missing_files(notebook, self.files), ["notes.txt", "../other/listings.csv"])


if __name__ == "__main__":
    unittest.main()
