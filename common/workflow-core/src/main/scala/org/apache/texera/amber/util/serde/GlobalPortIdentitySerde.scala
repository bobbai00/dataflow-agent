/*
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

package org.apache.texera.amber.util.serde
import org.apache.texera.amber.core.virtualidentity.{OperatorIdentity, PhysicalOpIdentity}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}

/**
  * Serialize and deserializes a GlobalPortIdentity object to a string using a custom, human-readable
  * format that works with both URI and file path. Fields are separated by commas and wrapped in
  * parentheses; the deserialization regex uses `[^,]+` for each field body, so any non-comma
  * character is allowed inside `logicalOpId` and `layerName` (underscores, dashes, dots, etc.).
  *
  * Historical note: an earlier VFS URI layout reserved underscore as a delimiter, and an older
  * version of this serde rejected `_` in `logicalOpId` / `layerName`. The VFS URI parser
  * (`VFSURIFactory.decodeURI`) now uses `/` as its only delimiter and the parenthesized payload
  * is extracted as a single segment, so the underscore restriction is no longer needed; the
  * guards were removed so agent-generated identifiers (which use camelCase or snake_case
  * indistinguishably) can flow through the engine unchanged.
  *
  * Negative `portId` values are still rejected with `IllegalArgumentException`.
  */
object GlobalPortIdentitySerde {
  implicit class SerdeOps(globalPortId: GlobalPortIdentity) {

    /**
      * Serializes a GlobalPortIdentity object into a string using our custom, human-readable format
      * that works with both URI and file path.
      *
      * @throws java.lang.IllegalArgumentException if `portId.id` is negative.
      * @return A serialized string representation of globalPortId
      */
    def serializeAsString: String = {
      val logicalOpId = globalPortId.opId.logicalOpId.id
      val layerName = globalPortId.opId.layerName
      val portId = globalPortId.portId.id
      val isInternal = globalPortId.portId.internal
      val isInput = globalPortId.input
      // A '/' would add path segments to the VFS URI these ids are interpolated
      // into, letting a user-chosen id forge structure the URI never meant to have
      // (e.g. a `wh/<name>` pair). Underscores are fine (see the class doc), but
      // path separators are not.
      require(
        !logicalOpId.contains('/'),
        s"logicalOpId must not contain '/' (VFS URI parsing relies on this): $logicalOpId"
      )
      require(
        !layerName.contains('/'),
        s"layerName must not contain '/' (VFS URI parsing relies on this): $layerName"
      )
      require(portId >= 0, s"portId must be non-negative: $portId")
      s"(logicalOpId=$logicalOpId,layerName=$layerName,portId=$portId,isInternal=$isInternal,isInput=$isInput)"
    }
  }

  /**
    * Deserializes a string as a GlobalPortIdentity object. Must use our custom format:
    * `(logicalOpId=<logicalOpId>,layerName=<layerName>,portId=<portId.id>,isInternal=<portId.internal>,isInput=<input>)`
    * @param serializedGlobalPortId A serialized string foramt of a GlobalPortIdentity
    * @return A desrialized GlobalPortIdentity, or IllegalArgumentException if the format is not correct.
    */
  def deserializeFromString(serializedGlobalPortId: String): GlobalPortIdentity = {
    val pattern =
      """\(logicalOpId=([^,]+),layerName=([^,]+),portId=([^,]+),isInternal=([^,]+),isInput=([^)]+)\)""".r
    serializedGlobalPortId match {
      case pattern(logicalOpId, layerName, portIdStr, isInternalStr, isInputStr) =>
        val portIdInt = portIdStr.toInt
        require(portIdInt >= 0, s"portId must be non-negative: $portIdInt")
        val isInternal = isInternalStr.toBoolean
        val isInput = isInputStr.toBoolean
        val physicalOpId = PhysicalOpIdentity(
          logicalOpId = OperatorIdentity(logicalOpId),
          layerName = layerName
        )
        val portId = PortIdentity(id = portIdInt, internal = isInternal)
        GlobalPortIdentity(opId = physicalOpId, portId = portId, input = isInput)
      case _ =>
        throw new IllegalArgumentException(
          s"Invalid GlobalPortIdentity format: $serializedGlobalPortId"
        )
    }
  }
}
