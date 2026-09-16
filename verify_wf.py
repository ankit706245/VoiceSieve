import json
import subprocess

out = subprocess.run(["docker", "exec", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", "SELECT workflow_definition FROM workflows WHERE id=3;"], capture_output=True, text=True)
wf = json.loads(out.stdout.strip())

nodes = wf.get('nodes', [])
for n in nodes:
    if 'tools' in n.get('data', {}):
        print("Node", n.get('data').get('name'), "Tools:", [t for t in n['data']['tools']])
