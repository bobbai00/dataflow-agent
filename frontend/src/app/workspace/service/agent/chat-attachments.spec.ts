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

import { ATTACHED_FILES_HEADER, fileNameOf, messageWithAttachments, splitAttachments } from "./chat-attachments";

describe("chat-attachments", () => {
  const listings = "/me@texera.dev/agent-uploads/v2/listings.csv";
  const reviews = "/me@texera.dev/agent-uploads/v2/reviews.csv";

  it("a message without files is its trimmed text", () => {
    expect(messageWithAttachments("  how many rows?  ", [])).toBe("how many rows?");
  });

  it("files follow the text under the header, one path per line", () => {
    expect(messageWithAttachments("how many rows?", [listings, reviews])).toBe(
      `how many rows?\n\n${ATTACHED_FILES_HEADER}\n${listings}\n${reviews}`
    );
  });

  it("a message of files alone is the header and the paths", () => {
    expect(messageWithAttachments("   ", [listings])).toBe(`${ATTACHED_FILES_HEADER}\n${listings}`);
  });

  it("splits a sent message back into its text and files", () => {
    expect(splitAttachments(messageWithAttachments("which is priciest?\nper area", [listings, reviews]))).toEqual({
      text: "which is priciest?\nper area",
      files: [listings, reviews],
    });
    expect(splitAttachments(messageWithAttachments("", [listings]))).toEqual({ text: "", files: [listings] });
  });

  it("keeps a message whole when it has no attached files", () => {
    expect(splitAttachments("load /me/ds/v1/a.csv please")).toEqual({ text: "load /me/ds/v1/a.csv please", files: [] });
    expect(splitAttachments(`notes\n${ATTACHED_FILES_HEADER}`)).toEqual({
      text: `notes\n${ATTACHED_FILES_HEADER}`,
      files: [],
    });
  });

  it("keeps a message whole when the header is followed by more than paths", () => {
    const content = `${ATTACHED_FILES_HEADER}\n${listings}\nand then compare them`;
    expect(splitAttachments(content)).toEqual({ text: content, files: [] });
  });

  it("names a file by the end of its path", () => {
    expect(fileNameOf(listings)).toBe("listings.csv");
    expect(fileNameOf("plain.csv")).toBe("plain.csv");
  });
});
