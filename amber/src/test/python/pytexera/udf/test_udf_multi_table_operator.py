# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""
The contract DataProcessingOpDesc's generated wrapper relies on: a multi-input
operator buffers every port, then runs process_tables once with each input
bound to the name declared at that port's index.
"""

from typing import Iterator, Optional

import pandas as pd
import pytest

from pytexera import Table, TableLike, UDFMultiTableOperator


def table(**columns) -> Table:
    return Table(pd.DataFrame(columns))


class JoinOperator(UDFMultiTableOperator):
    INPUT_PORTS = ["left", "right"]

    def __init__(self):
        super().__init__()
        self.calls = 0

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        self.calls += 1
        yield pd.DataFrame(self.left).merge(pd.DataFrame(self.right), on="id")


class ThreeInputOperator(UDFMultiTableOperator):
    INPUT_PORTS = ["first", "second", "third"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        yield pd.DataFrame(
            {
                "first": self.first["value"],
                "second": self.second["value"],
                "third": self.third["value"],
            }
        )


class OneInputOperator(UDFMultiTableOperator):
    INPUT_PORTS = ["only"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        yield pd.DataFrame(self.only)


class TwoOutputsOperator(UDFMultiTableOperator):
    INPUT_PORTS = ["only"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        yield pd.DataFrame(self.only).head(1)
        yield pd.DataFrame(self.only).tail(1)


class UndeclaredPortsOperator(UDFMultiTableOperator):
    def process_tables(self) -> Iterator[Optional[TableLike]]:
        yield pd.DataFrame({"ran": [True]})


class TestUDFMultiTableOperator:
    def test_one_port_runs_as_soon_as_it_arrives(self):
        out = list(OneInputOperator().process_table(table(id=[1, 2]), 0))
        assert len(out) == 1
        assert out[0]["id"].tolist() == [1, 2]

    def test_nothing_is_emitted_until_the_last_port_arrives(self):
        op = JoinOperator()
        assert list(op.process_table(table(id=[1, 2], a=[10, 20]), 0)) == []
        assert op.calls == 0

        out = list(op.process_table(table(id=[2, 3], b=[200, 300]), 1))

        assert op.calls == 1
        assert len(out) == 1
        assert out[0].to_dict("list") == {"id": [2], "a": [20], "b": [200]}

    @pytest.mark.parametrize("order", [(0, 1, 2), (2, 1, 0), (1, 2, 0)])
    def test_inputs_bind_by_port_index_whatever_the_arrival_order(self, order):
        op = ThreeInputOperator()
        emitted = []
        for position, port in enumerate(order):
            emitted = list(op.process_table(table(value=[port * 10]), port))
            if position < len(order) - 1:
                assert emitted == []

        assert len(emitted) == 1
        assert emitted[0].to_dict("list") == {
            "first": [0],
            "second": [10],
            "third": [20],
        }

    def test_every_yielded_table_is_passed_on(self):
        out = list(TwoOutputsOperator().process_table(table(id=[1, 2, 3]), 0))
        assert [frame["id"].tolist() for frame in out] == [[1], [3]]

    def test_no_declared_ports_means_one_input(self):
        out = list(UndeclaredPortsOperator().process_table(table(id=[1]), 0))
        assert len(out) == 1
        assert out[0]["ran"].tolist() == [True]
