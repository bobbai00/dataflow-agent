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

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentInfo } from "../types";
import { ImportDialog } from "./ImportDialog";

export function AgentList() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { agents } = await api.listAgents();
      setAgents(agents);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    // Poll while the page is open. Agents come and go (create / delete /
    // import) and we'd rather refresh in the background than make the user
    // hit reload to see a new agent appear.
    const handle = window.setInterval(refresh, 3000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Texera Agent Trace</h1>
        <div className="actions">
          <button onClick={refresh}>Refresh</button>
          <button className="primary" onClick={() => setImportOpen(true)}>
            Import…
          </button>
        </div>
      </header>
      <div className="app-body">
        <div className="agent-list">
          {error && <div className="error-banner">{error}</div>}
          {agents === null ? (
            <div className="muted">Loading…</div>
          ) : agents.length === 0 ? (
            <div className="agent-table">
              <div className="empty">
                No agents yet. Create one through the API or click <strong>Import…</strong>{" "}
                above to load a <code>react_steps.json</code> trace.
              </div>
            </div>
          ) : (
            <table className="agent-table">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Driver</th>
                  <th>State</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {agents.map(a => (
                  <tr key={a.id} onClick={() => (window.location.hash = `#/agents/${encodeURIComponent(a.id)}`)}>
                    <td className="mono">{a.id}</td>
                    <td>{a.name}</td>
                    <td className="mono dim">{a.modelType}</td>
                    <td>
                      <span className="pill driver">{a.driver}</span>
                    </td>
                    <td>
                      <span className={`pill state-${a.state}`}>{a.state}</span>
                    </td>
                    <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button
                        className="ghost"
                        onClick={async () => {
                          if (!confirm(`Delete agent ${a.id}?`)) return;
                          await api.deleteAgent(a.id).catch(err => setError(String(err)));
                          refresh();
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {importOpen && (
        <ImportDialog
          onClose={() => {
            setImportOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
