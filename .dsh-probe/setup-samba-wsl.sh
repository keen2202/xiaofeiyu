#!/bin/bash
# Expose the WSL SSHFS mount (remote Tencent host) as an SMB share for Windows.
# Run as root inside WSL: wsl -u root -e bash /mnt/d/Workespace/xiaofeiyu/.dsh-probe/setup-samba-wsl.sh
set -e
export DEBIAN_FRONTEND=noninteractive

if ! command -v smbd >/dev/null 2>&1; then
  apt-get install -y -qq samba >>/tmp/samba-install.log 2>&1 || { echo SAMBA_INSTALL_FAILED; tail -60 /tmp/samba-install.log; exit 1; }
fi

id bili >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin bili

[ -f /etc/samba/smb.conf.orig ] || cp /etc/samba/smb.conf /etc/samba/smb.conf.orig 2>/dev/null || true

cat > /etc/samba/smb.conf <<'EOF'
[global]
   workgroup = WORKGROUP
   server role = standalone server
   security = user
   map to guest = never
   log file = /var/log/samba/log.%m
   max log size = 1000
   server min protocol = SMB2
   smb ports = 445
   disable netbios = yes
   dns proxy = no

[dsh-bili-backups]
   path = /home/keen2206/dsh-bili-backups
   browseable = yes
   read only = no
   writable = yes
   valid users = bili
   force user = keen2206
   create mask = 0644
   directory mask = 0755
EOF

PASSFILE=/mnt/d/Workespace/xiaofeiyu/.dsh-probe/smb-pass.txt
if [ -f "$PASSFILE" ]; then
  pass="$(tr -d '\r\n' < "$PASSFILE")"
  printf '%s\n%s\n' "$pass" "$pass" | smbpasswd -a -s bili >/dev/null
fi

if systemctl list-unit-files 2>/dev/null | grep -q '^smbd\.service'; then
  systemctl enable smbd >/dev/null 2>&1 || true
  systemctl restart smbd
else
  pkill -x smbd 2>/dev/null || true
  smbd -D
fi

sleep 1
if ss -ltn | grep -q ':445'; then
  echo SAMBA_UP
else
  echo SAMBA_NOT_LISTENING
  exit 1
fi
