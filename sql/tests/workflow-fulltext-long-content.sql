/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

-- Run with psql -v ON_ERROR_STOP=1 -d texera_db -f this-file.sql.
-- Uses temporary objects and rolls back. Test the installed index's tokenizer
-- option, so it fails before migration 32 and passes afterwards.
BEGIN;
SET LOCAL search_path TO texera_db, public;
SET LOCAL statement_timeout = '40s';
CREATE TEMP TABLE analysis_state_persist_probe (content text);
DO $$
DECLARE tokenizer text;
BEGIN
  SELECT option_value INTO STRICT tokenizer
  FROM pg_class c, pg_options_to_table(c.reloptions)
  WHERE c.oid = 'texera_db.idx_workflow_pgroonga'::regclass
    AND option_name = 'tokenizer';
  EXECUTE format('CREATE INDEX analysis_state_persist_probe_idx ON analysis_state_persist_probe USING pgroonga (content) WITH (tokenizer=%L)', tokenizer);
END $$;
INSERT INTO analysis_state_persist_probe
SELECT repeat('{"code":"def f(a): return a", "name":"analysis"},', 200000);
SET LOCAL enable_seqscan = off;
DO $$
BEGIN
  IF (SELECT count(*) FROM analysis_state_persist_probe WHERE content &@~ 'analysis') <> 1 THEN
    RAISE EXCEPTION 'Large workflow was not searchable';
  END IF;
  IF (SELECT content FROM analysis_state_persist_probe) <>
     repeat('{"code":"def f(a): return a", "name":"analysis"},', 200000) THEN
    RAISE EXCEPTION 'Workflow content was modified';
  END IF;
END $$;
ROLLBACK;
