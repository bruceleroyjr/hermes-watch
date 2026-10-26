#!/bin/bash
# PC health snapshot on macOS for the "how's my PC doing" voice command (see isPcHealthRequest
# in lib/voice-common.js): the counterpart of pc-health.ps1. Read-only, no sudo, no jq; prints
# one compact JSON object in the same shape so lib/pc-health.js reads either.
# Drive SMART status, pending restarts and unexpected shutdowns have no clean non-sudo source
# here, so those fields are left out rather than guessed (formatPcHealth treats them as absent).
set -u
export LC_ALL=C

# A JSON string body: control characters dropped, backslashes and quotes escaped.
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

cpu_model=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)

# top's first sample is the average since boot; the second, a second later, is the load now.
cpu_load=$(top -l 2 -n 0 -s 1 2>/dev/null | awk '
  /^CPU usage:/ { idle = $0; sub(/.*, /, "", idle); sub(/% idle.*/, "", idle) }
  END { if (idle == "") idle = 100; printf "%d", int(100 - idle + 0.5) }')

# Used = wired + active + compressed, close to Activity Monitor's "Memory Used".
mem_total_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
read -r mem_total_gb mem_used_gb mem_used_pct < <(vm_stat 2>/dev/null | awk -v total="${mem_total_bytes:-0}" '
  /page size of/ { page = $8 + 0 }
  /^Pages wired down:/ { used += $4 + 0 }
  /^Pages active:/ { used += $3 + 0 }
  /^Pages occupied by compressor:/ { used += $5 + 0 }
  END { if (!page) page = 4096; used *= page; gb = 1073741824
    printf "%.1f %.1f %d", total / gb, used / gb, (total ? int(100 * used / total + 0.5) : 0) }')
: "${mem_total_gb:=0}" "${mem_used_gb:=0}" "${mem_used_pct:=0}"

# kern.boottime prints "{ sec = 1759700000, usec = 123 } Mon Oct  5 ..."; same "2d 3h 56m" as Windows.
now=$(date +%s)
boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p')
uptime_str=$(awk -v b="${boot:-$now}" -v n="$now" 'BEGIN { s = n - b; if (s < 0) s = 0
  printf "%dd %dh %dm", int(s / 86400), int(s % 86400 / 3600), int(s % 3600 / 60) }')

proc_count=$(ps -axo pid= 2>/dev/null | wc -l | tr -d ' ')

# Real volumes only: "/" and whatever is mounted under /Volumes (external drives, disk images),
# not the APFS synthetic mounts under /System/Volumes that share the boot container anyway.
disks=''
while IFS=$'\t' read -r name size_gb free_gb free_pct; do
  [ -n "$name" ] || continue
  disks="$disks${disks:+,}{\"drive\":\"$(json_str "$name")\",\"sizeGB\":$size_gb,\"freeGB\":$free_gb,\"freePct\":$free_pct}"
done < <(df -Pk 2>/dev/null | awk '
  NR > 1 && $1 ~ /^\/dev\// {
    mount = $6; for (i = 7; i <= NF; i++) mount = mount " " $i
    if (mount != "/" && mount !~ /^\/Volumes\/./) next
    name = mount; if (name != "/") sub(/^\/Volumes\//, "", name)
    printf "%s\t%d\t%.1f\t%d\n", name, int($2 / 1048576 + 0.5), $4 / 1048576, ($2 ? int(100 * $4 / $2 + 0.5) : 0)
  }')

# Resident memory per process name (the executable's basename), top 5 like Get-Process on Windows.
top_mem=''
while IFS=$'\t' read -r mem_mb count name; do
  [ -n "$name" ] || continue
  top_mem="$top_mem${top_mem:+,}{\"name\":\"$(json_str "$name")\",\"count\":$count,\"memMB\":$mem_mb}"
done < <(ps -axo rss=,comm= 2>/dev/null | awk '
  { rss = $1 + 0; name = $0; sub(/^ *[0-9]+ +/, "", name); sub(/.*\//, "", name)
    if (name == "" || name == "kernel_task") next
    mem[name] += rss; count[name]++ }
  END { for (n in mem) printf "%d\t%d\t%s\n", int(mem[n] / 1024 + 0.5), count[n], n }' | sort -rn | head -5)

printf '{"cpuModel":"%s","cpuLoadPct":%s,"memTotalGB":%s,"memUsedGB":%s,"memUsedPct":%s,"uptime":"%s","processCount":%s,"disks":[%s],"topMemory":[%s]}\n' \
  "$(json_str "$cpu_model")" "${cpu_load:-0}" "$mem_total_gb" "$mem_used_gb" "$mem_used_pct" "$uptime_str" "${proc_count:-0}" "$disks" "$top_mem"
