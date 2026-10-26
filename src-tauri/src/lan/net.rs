//! 私网/本机地址判定：局域网更新通道唯一的安全口子。
//!
//! 明文 HTTP 只对「IP 字面量 + 私网」放行。域名一律不接受——DNS 无法保证解析结果
//! 落在私网，也无法保证下一次解析还是同一个地址，用它做边界等于没有边界。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// 是否属于私网或本机地址（IPv4 映射地址先归一成 v4 再判）。
pub fn is_private_or_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_private_v4(v4),
            None => is_private_v6(v6),
        },
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    // `is_private` 恰好覆盖 10/8、172.16/12、192.168/16 三段，不再手写位运算。
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80) // fe80::/10 链路本地
        || (o[0] & 0xfe) == 0xfc // fc00::/7 唯一本地
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> bool {
        is_private_or_local(s.parse().expect("测试地址必须可解析"))
    }

    #[test]
    fn ipv4_private_ranges_are_recognised() {
        for ok in ["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.3.4"] {
            assert!(p(ok), "{ok} 应判为私网/本机");
        }
    }

    /// 这三条是边界外最容易被误判的邻接地址：172.32 不是私网，192.169 不是私网。
    #[test]
    fn public_addresses_are_rejected() {
        for bad in ["8.8.8.8", "172.32.0.1", "192.169.0.1", "100.64.0.1", "1.1.1.1", "0.0.0.0"] {
            assert!(!p(bad), "{bad} 不得被判为私网");
        }
    }

    #[test]
    fn ipv6_loopback_link_local_and_ula_are_recognised() {
        for ok in ["::1", "fe80::1", "fc00::1", "fd12:3456::1"] {
            assert!(p(ok), "{ok} 应判为私网/本机");
        }
        for bad in ["2001:db8::1", "::", "ff02::1"] {
            assert!(!p(bad), "{bad} 不得被判为私网");
        }
    }

    /// 双栈 socket 常给出 `::ffff:a.b.c.d` 形式，必须先归一成 v4，否则内网地址会被当成 v6 拒掉。
    #[test]
    fn v4_mapped_v6_addresses_are_judged_as_v4() {
        assert!(p("::ffff:10.0.0.1"));
        assert!(p("::ffff:192.168.1.1"));
        assert!(!p("::ffff:8.8.8.8"));
    }
}
