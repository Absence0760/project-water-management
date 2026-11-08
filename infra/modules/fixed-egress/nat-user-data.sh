#!/bin/bash
# First boot of the fixed-egress NAT instance (Amazon Linux 2023, arm64;
# main.tf). Forwards the private subnets' HTTPS out of its one ENI,
# masqueraded to the Elastic IP, and applies security updates daily.
# A change here replaces the instance (user_data_replace_on_change); the
# ENI and its address stay.
set -euo pipefail

# Forwarding, now and after every reboot.
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-nat.conf
sysctl --system >/dev/null

# The Elastic IP is on the ENI before boot, so the repositories answer;
# retry anyway in case the first boot races the route.
ok=0
for _ in 1 2 3 4 5 6; do
	if dnf install -y nftables dnf-automatic; then ok=1; break; fi
	sleep 10
done
[ "$ok" = 1 ]

dev="$(ip -4 route show default | awk '{print $5; exit}')"

# Forward only new HTTPS connections and their replies. (No MSS clamp: the
# far ends advertise 1460 or less, and ICMP "fragmentation needed" passes as
# related.)
cat > /etc/sysconfig/nftables.conf <<NFT
flush ruleset
table ip nat {
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		oifname "${dev}" masquerade
	}
}
table inet filter {
	chain forward {
		type filter hook forward priority filter; policy drop;
		ct state established,related accept
		iifname "${dev}" oifname "${dev}" tcp dport 443 ct state new accept
	}
}
NFT
# A ruleset that doesn't parse fails the boot here, before it replaces anything.
nft -c -f /etc/sysconfig/nftables.conf
systemctl enable nftables
systemctl restart nftables

# Security updates, applied daily. AL2023 pins dnf to the AMI's release
# (/etc/dnf/vars/releasever), so without "latest" dnf-automatic would never
# see a newer release's fixes. A kernel update needs a reboot to take effect:
# replace the instance now and then (docs/deployment.md § Fixed egress).
echo latest > /etc/dnf/vars/releasever
sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer
