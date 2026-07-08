import json, glob, os, re, sys
SUT="DataflowSystemGPT52DeltaStats5k"
ROOT="/home/bob/Desktop/bobflow/Kramabench/system_scratch/"+SUT

def parents_of(code):
    m=re.search(r'def\s+(load|process)\s*\(([^)]*)\)', code or "")
    if not m: return None  # unknown
    if m.group(1)=="load": return []
    args=[a.strip().split(':')[0].split('=')[0].strip() for a in m.group(2).split(',') if a.strip()]
    return [a for a in args if a and a not in ("self",)]

def extract(task_dir):
    try: steps=json.load(open(os.path.join(task_dir,"react_steps.json")))["steps"]
    except: return None
    existing={}         # opId -> current parents tuple
    step_ops=[]         # list of per-step op-batches
    for st in steps:
        if st.get("role")!="agent": continue
        batch=[]
        for tc in (st.get("toolCalls") or []):
            tn=tc.get("toolName"); inp=tc.get("input") or {}
            op=inp.get("operatorId")
            if tn=="createOrModifyOperator" and op:
                par=parents_of(inp.get("code",""))
                if op not in existing:
                    batch.append(("INSERT",op,par if par is not None else []))
                    existing[op]=tuple(par or [])
                else:
                    old=existing[op]; new=tuple(par or [])
                    kind="REWIRE" if (par is not None and new!=old) else "UPDATE"
                    batch.append((kind,op,list(new)))
                    if par is not None: existing[op]=new
            elif tn=="deleteOperator" and op:
                batch.append(("DELETE",op,[]))
                existing.pop(op,None)
        if batch: step_ops.append(batch)
    return step_ops

def notation(step_ops):
    lines=[]
    for i,batch in enumerate(step_ops,1):
        toks=[]
        for kind,op,par in batch:
            if kind=="INSERT":
                toks.append(f"insert {op}" if not par else f"insert ({'+'.join(par)}→{op})")
            elif kind=="UPDATE": toks.append(f"update {op}")
            elif kind=="REWIRE": toks.append(f"rewire {op}←({'+'.join(par)})")
            elif kind=="DELETE": toks.append(f"delete {op}")
        lines.append(f"  s{i}: " + " , ".join(toks))
    return "\n".join(lines)

if __name__=="__main__" and len(sys.argv)>1 and sys.argv[1]=="show":
    for t in sys.argv[2:]:
        so=extract(os.path.join(ROOT,t))
        print(f"### {t}\n{notation(so)}\n")
