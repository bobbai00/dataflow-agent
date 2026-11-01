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

/*
 * A native dataflow's content runs to megabytes, and the workflow search index's MeCab
 * tokenizer refuses a text that long ("too long sentence"), which fails the save.
 * Bigrams have no length limit and keep the dashboard's full-text search working.
 */

\c texera_db

SET search_path TO texera_db;

BEGIN;

DROP INDEX IF EXISTS idx_workflow_pgroonga;

CREATE INDEX idx_workflow_pgroonga ON workflow
    USING pgroonga ((COALESCE(name, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(content, '')))
    WITH (tokenizer = 'TokenBigram', plugins = 'token_filters/stem', token_filters = 'TokenFilterStem');

COMMIT;
