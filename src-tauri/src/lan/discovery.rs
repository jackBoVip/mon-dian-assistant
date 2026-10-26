//! 组播发现：源机器周期性宣告「我有哪个版本」，客户端收集后选版本最高的一台。
//!
//! 报文只携带地址与版本，**不携带任何内容摘要以外的信任信息**——找到源不等于信任源，
//! 清单仍必须过 Ed25519 验签。因此组播报文被伪造最多让界面多出一行无效源。
//!
//! 同时向组播组与受限广播各发一份：企业网常禁 IGMP，只发组播会在部分交换机上静默失效。

use std::cmp::Ordering;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 239/8 是 IPv4 管理域地址，避开 SSDP(239.255.255.250) 与 mDNS。
pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 77);
pub const PORT: u16 = 37020;
pub const APP_ID: &str = "mda-update";
pub const PROTO: u8 = 1;
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(3);
/// 三个宣告周期收不到就当源已下线：单包丢失不应让源在界面里闪烁。
pub const SOURCE_TTL: Duration = Duration::from_secs(10);
const MAX_PACKET: usize = 512;
const MAX_LABEL: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Announce {
    pub app: String,
    pub proto: u8,
    /// 进程实例号：区分「同一台机器重启后的新源」与「旧包被重放」。
    pub instance: String,
    pub host: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub port: u16,
    #[serde(default)]
    pub started_at: u64,
    #[serde(default)]
    pub seq: u64,
}

pub fn encode(a: &Announce) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(a).ok()?;
    (bytes.len() <= MAX_PACKET).then_some(bytes)
}

/// 解码并做协议级过滤。任何一项不合规都返回 `None`，调用方直接丢包。
pub fn decode(bytes: &[u8]) -> Option<Announce> {
    if bytes.is_empty() || bytes.len() > MAX_PACKET {
        return None;
    }
    let a: Announce = serde_json::from_slice(bytes).ok()?;
    if a.app != APP_ID || a.proto != PROTO {
        return None;
    }
    if a.instance.is_empty() || a.port == 0 {
        return None;
    }
    if a.host.len() > MAX_LABEL || a.version.len() > 32 || a.platform.len() > 16 || a.arch.len() > 16 {
        return None;
    }
    Some(a)
}

/// 监听 socket：抢占固定端口并加入组播组。
pub fn listener_socket() -> std::io::Result<UdpSocket> {
    let sock = new_udp_socket()?;
    sock.set_reuse_address(true)?;
    // 同一台机器若同时跑了调试实例，两个进程要能同时收到宣告。
    #[cfg(all(unix, not(target_os = "solaris"), not(target_os = "illumos")))]
    sock.set_reuse_port(true)?;
    sock.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, PORT)).into())?;
    let udp: UdpSocket = sock.into();
    udp.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED)?;
    // 宣告不出本网段，避免泄漏到无关子网。
    udp.set_multicast_ttl_v4(1)?;
    Ok(udp)
}

/// 发送 socket：不需要固定端口，但必须允许广播。
pub fn sender_socket() -> std::io::Result<UdpSocket> {
    let sock = new_udp_socket()?;
    sock.set_broadcast(true)?;
    sock.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?;
    let udp: UdpSocket = sock.into();
    udp.set_multicast_ttl_v4(1)?;
    Ok(udp)
}

fn new_udp_socket() -> std::io::Result<socket2::Socket> {
    socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, Some(socket2::Protocol::UDP))
}

/// 双发：组播一份、受限广播一份。返回成功发出的份数。
pub fn broadcast_announce(sock: &UdpSocket, payload: &[u8]) -> usize {
    let mut sent = 0;
    if sock.send_to(payload, SocketAddr::from((GROUP, PORT))).is_ok() {
        sent += 1;
    }
    if sock.send_to(payload, SocketAddr::from((Ipv4Addr::BROADCAST, PORT))).is_ok() {
        sent += 1;
    }
    sent
}

#[derive(Debug, Clone)]
pub struct Source {
    pub announce: Announce,
    pub addr: IpAddr,
    pub seen: Instant,
}

/// 已发现源的存活表。版本比较复用 `update::is_newer`，不在这里另写一套解析。
#[derive(Default)]
pub struct SourceTable {
    entries: HashMap<String, Source>,
}

impl SourceTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert(&mut self, announce: Announce, addr: IpAddr, now: Instant) {
        self.entries.insert(
            announce.instance.clone(),
            Source { announce, addr, seen: now },
        );
    }

    pub fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|_, s| now.saturating_duration_since(s.seen) < SOURCE_TTL);
    }

    /// 全部存活源，按「版本高 → 最近收到 → 实例号」排序。顺序确定，界面不会自己跳。
    pub fn sources(&mut self, now: Instant) -> Vec<Source> {
        self.prune(now);
        let mut list: Vec<Source> = self.entries.values().cloned().collect();
        list.sort_by(|a, b| {
            let (av, bv) = (&a.announce.version, &b.announce.version);
            if crate::update::is_newer(av, bv) {
                return Ordering::Less;
            }
            if crate::update::is_newer(bv, av) {
                return Ordering::Greater;
            }
            b.seen
                .cmp(&a.seen)
                .then_with(|| a.announce.instance.cmp(&b.announce.instance))
        });
        list
    }

    pub fn best(&mut self, now: Instant) -> Option<Source> {
        self.sources(now).into_iter().next()
    }

    /// 关闭发现时立即清空：界面上不该再留着「刚才还在」的源。
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&mut self, now: Instant) -> usize {
        self.prune(now);
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn announce(instance: &str, version: &str) -> Announce {
        Announce {
            app: APP_ID.into(),
            proto: PROTO,
            instance: instance.into(),
            host: "MBP-01".into(),
            version: version.into(),
            platform: "macos".into(),
            arch: "aarch64".into(),
            port: 8765,
            started_at: 1_760_000_000,
            seq: 7,
        }
    }

    #[test]
    fn announce_roundtrip() {
        let a = announce("inst-1", "0.2.0");
        let bytes = encode(&a).expect("应可编码");
        assert!(bytes.len() <= MAX_PACKET);
        assert_eq!(decode(&bytes), Some(a));
    }

    /// 异 app、异协议版本、坏 JSON、超长包一律丢：宁可少发现一个源，也不让垃圾进表。
    #[test]
    fn foreign_or_malformed_packets_are_dropped() {
        let mut other_app = announce("inst-1", "0.2.0");
        other_app.app = "someone-else".into();
        assert_eq!(decode(&serde_json::to_vec(&other_app).unwrap()), None);

        let mut other_proto = announce("inst-1", "0.2.0");
        other_proto.proto = 2;
        assert_eq!(decode(&serde_json::to_vec(&other_proto).unwrap()), None);

        let mut no_port = announce("inst-1", "0.2.0");
        no_port.port = 0;
        assert_eq!(decode(&serde_json::to_vec(&no_port).unwrap()), None);

        assert_eq!(decode(b"not json"), None);
        assert_eq!(decode(&[]), None);
        assert_eq!(decode(&vec![b'x'; MAX_PACKET + 1]), None);
    }

    #[test]
    fn best_prefers_higher_version() {
        let t0 = Instant::now();
        let mut table = SourceTable::new();
        table.upsert(announce("a", "0.1.0"), "10.0.0.2".parse().unwrap(), t0);
        table.upsert(announce("b", "0.2.0"), "10.0.0.3".parse().unwrap(), t0);

        let best = table.best(t0).expect("应有源");
        assert_eq!(best.announce.instance, "b");
        assert_eq!(best.addr, "10.0.0.3".parse::<IpAddr>().unwrap());
    }

    /// 同版本时最近一次宣告优先；再相同则按实例号，保证每次排序结果一致。
    #[test]
    fn same_version_falls_back_to_recency_then_instance() {
        let t0 = Instant::now();
        let mut table = SourceTable::new();
        table.upsert(announce("a", "0.2.0"), "10.0.0.2".parse().unwrap(), t0);
        table.upsert(announce("b", "0.2.0"), "10.0.0.3".parse().unwrap(), t0 + Duration::from_secs(1));
        assert_eq!(table.best(t0 + Duration::from_secs(2)).unwrap().announce.instance, "b");

        let same = Instant::now();
        let mut tie = SourceTable::new();
        tie.upsert(announce("z", "0.2.0"), "10.0.0.9".parse().unwrap(), same);
        tie.upsert(announce("m", "0.2.0"), "10.0.0.8".parse().unwrap(), same);
        assert_eq!(tie.best(same).unwrap().announce.instance, "m");
    }

    #[test]
    fn stale_sources_are_pruned() {
        let t0 = Instant::now();
        let mut table = SourceTable::new();
        table.upsert(announce("a", "0.2.0"), "10.0.0.2".parse().unwrap(), t0);
        assert_eq!(table.len(t0 + SOURCE_TTL - Duration::from_millis(1)), 1);
        assert_eq!(table.len(t0 + SOURCE_TTL), 0, "过期源必须下线，否则界面会显示幽灵机器");
        assert!(table.best(t0 + SOURCE_TTL).is_none());
    }

    /// 同一实例换 IP（DHCP 续租/切网卡）时只保留最新一条，不在列表里堆重复项。
    #[test]
    fn same_instance_replaces_previous_address() {
        let t0 = Instant::now();
        let mut table = SourceTable::new();
        table.upsert(announce("a", "0.2.0"), "10.0.0.2".parse().unwrap(), t0);
        table.upsert(announce("a", "0.2.0"), "10.0.0.7".parse().unwrap(), t0 + Duration::from_secs(1));
        let list = table.sources(t0 + Duration::from_secs(1));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].addr, "10.0.0.7".parse::<IpAddr>().unwrap());
    }
}
