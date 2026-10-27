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

/**
 * Files dropped on the chat are attached to the message being written, not
 * pasted into it. A sent message carries them after its text, under this
 * line, one dataset path per line: the agent reads the paths there, and the
 * chat shows them as file chips again.
 */
export const ATTACHED_FILES_HEADER = "Attached files:";

/** The message to send: the typed text, then the attached files' dataset paths. */
export function messageWithAttachments(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (paths.length === 0) {
    return body;
  }
  const files = [ATTACHED_FILES_HEADER, ...paths].join("\n");
  return body ? `${body}\n\n${files}` : files;
}

/**
 * A sent message split back into its text and its attached files. A message
 * whose last header line is not followed by paths alone keeps its whole text.
 */
export function splitAttachments(content: string): { text: string; files: string[] } {
  const lines = content.split("\n");
  const at = lines.lastIndexOf(ATTACHED_FILES_HEADER);
  if (at === -1) {
    return { text: content, files: [] };
  }
  const files = lines
    .slice(at + 1)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (files.length === 0 || !files.every(file => file.startsWith("/") && !/\s/.test(file))) {
    return { text: content, files: [] };
  }
  return { text: lines.slice(0, at).join("\n").trimEnd(), files };
}

/** The file name a dataset path ends with. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
