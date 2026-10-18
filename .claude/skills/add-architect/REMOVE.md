# Remove add-architect

Reverses every file the skill's apply step copied. Run from the NanoClaw project root.

```bash
rm -rf templates/engineering/architect
rmdir templates/engineering 2>/dev/null || true
rm -f src/templates/fork-architect-template.test.ts
```

An agent already stamped from the template keeps running; the template is only its source for
restamps. To retire the agent as well, after the owner says so:

```bash
ncl groups list                       # find the Architect's id
ncl groups delete --id <group-id>     # removes the group, its sessions, run folders and destinations
```

The mirror mount is per-group container config and goes with the group. The mount allowlist
entry (`~/.config/nanoclaw/mount-allowlist.json`) and the mirrors on the host are the
operator's; remove them by hand if nothing else uses them. The Scout's `architect` destination
row goes with `ncl destinations remove --agent-group-id <scout-id> --local-name architect`.
