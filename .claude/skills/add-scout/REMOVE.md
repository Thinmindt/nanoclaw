# Remove add-scout

Reverses every file the skill's apply step copied. Run from the NanoClaw project root.

```bash
rm -rf templates/engineering/scout
rmdir templates/engineering 2>/dev/null || true
rm -f src/templates/fork-scout-template.test.ts
```

An agent already stamped from the template keeps running; the template is only its source for
restamps. To retire the agent as well, after the owner says so:

```bash
ncl destinations remove --agent-group-id <architect-id> --local-name scout
ncl groups list                       # find the Scout's id
ncl groups delete --id <group-id>     # removes the group, its sessions and destinations
```

The gateway identity with open GET is the operator's; remove it in the gateway's console so no
other group can be given it by mistake.
