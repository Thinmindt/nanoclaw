# Remove add-project-manager

Reverses every file the skill's apply step copied. Run from the NanoClaw project root.

```bash
rm -rf templates/engineering/project-manager
rmdir templates/engineering 2>/dev/null || true
rm -f src/templates/fork-project-manager-template.test.ts
```

Agents already stamped from the template keep running; the template is only their source for
restamps. To retire the agent as well, after the owner says so:

```bash
ncl groups list                       # find the Project Manager's id
ncl groups delete --id <group-id>     # removes the group, its sessions, tasks and destinations
```

Mounts added for it are per-group container config and go with the group. The mount allowlist
entries (`~/.config/nanoclaw/mount-allowlist.json`) and the workbench repository on the host are
the operator's; remove them by hand if nothing else uses them.
