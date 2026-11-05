# Spike: what did the isolated-HOME sessions send to the local API stub? Names and counts only.
import json

rows = [json.loads(line) for line in open('/home/prashant/projects/Clearance/data/spike-logs/anthropic-stub.jsonl')]
print(len(rows), 'requests; paths', sorted({r['path'] for r in rows}))
for r in [r for r in rows if r['path'].endswith('/v1/messages')][-3:]:
    names = r['tool_names']
    print(
        r['at'], r['model'],
        'tools', len(names),
        'claude_ai', sum(n.startswith('mcp__claude_ai') for n in names),
        'switch', sum(n.startswith('mcp__switch') for n in names),
        'x_api_key', r['x_api_key'],
        'bearer', r['bearer'],
    )
