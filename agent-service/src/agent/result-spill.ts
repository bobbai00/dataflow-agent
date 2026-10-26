/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "bun:jsc";

/** Where a value was written: its byte range in the spill file. */
export interface SpillRange {
  offset: number;
  length: number;
}

/**
 * An append-only file of values, written once and read back on demand: the
 * operator results the snapshot tree keeps but no snapshot near HEAD reads
 * (WorkflowSnapshotStorage.compact). Values are stored in the structured-clone
 * format, so they come back exactly as written. The file is unlinked as soon as
 * it is opened: it lives as long as the open descriptor, and nothing is left
 * behind when the process ends.
 */
export class ResultSpill {
  private fd: number | undefined;
  private end = 0;

  write(value: unknown): SpillRange {
    const bytes = serialize(value, { binaryType: "nodebuffer" });
    const fd = this.open();
    const offset = this.end;
    for (let written = 0; written < bytes.length; )
      written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
    this.end += bytes.length;
    return { offset, length: bytes.length };
  }

  read(range: SpillRange): unknown {
    const bytes = Buffer.allocUnsafe(range.length);
    for (let read = 0; read < range.length; ) {
      const count = readSync(this.fd!, bytes, read, range.length - read, range.offset + read);
      if (count === 0) throw new Error("result spill file is shorter than a recorded range");
      read += count;
    }
    return deserialize(bytes);
  }

  /** Bytes written so far. */
  get size(): number {
    return this.end;
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    this.end = 0;
  }

  private open(): number {
    if (this.fd === undefined) {
      const dir = mkdtempSync(join(tmpdir(), "texera-agent-results-"));
      const path = join(dir, "results.bin");
      this.fd = openSync(path, "w+");
      rmSync(dir, { recursive: true, force: true });
    }
    return this.fd;
  }
}
