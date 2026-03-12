/**
 * trojan-proxy.ts
 * 直接实现 Trojan 协议，绕过 Clash 全局切换，实现请求级节点隔离
 * Trojan 协议：TLS 握手 → SHA224(password) + CRLF + CONNECT 请求头 + CRLF → 透传
 */

import * as tls from 'tls';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { Dispatcher, errors } from 'undici';

export interface TrojanNode {
  name: string;
  server: string;
  port: number;
  password: string;
  sni: string;
  skipCertVerify: boolean;
}

let nodePool: TrojanNode[] = [];
let nodeIndex = 0;

/**
 * 从 Clash config.yaml 加载 Trojan 节点
 */
export function loadTrojanNodes(configPath: string): TrojanNode[] {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = parseYaml(raw);
  const proxies: any[] = config.proxies || [];

  const nodes = proxies
    .filter((p: any) => p.type === 'trojan' && p.server && p.port && p.password)
    // 排除信息节点（流量/到期）
    .filter((p: any) => !/剩余|到期/.test(p.name || ''))
    .map((p: any) => ({
      name: p.name || `${p.server}:${p.port}`,
      server: p.server,
      port: p.port,
      password: p.password,
      sni: p.sni || p.server,
      skipCertVerify: p['skip-cert-verify'] ?? false,
    }));

  return nodes;
}

export function initTrojanPool(configPath: string): void {
  nodePool = loadTrojanNodes(configPath);
  if (nodePool.length === 0) {
    throw new Error('No trojan nodes found in clash config');
  }
  console.log(`[trojan-proxy] Loaded ${nodePool.length} nodes`);
}

/**
 * 轮询取下一个节点
 */
export function getNextTrojanNode(): TrojanNode | undefined {
  if (nodePool.length === 0) return undefined;
  const node = nodePool[nodeIndex % nodePool.length];
  nodeIndex++;
  console.log(`[TrojanPool] 使用节点 [${nodeIndex}/${nodePool.length}]: ${node.name}`);
  return node;
}

/**
 * 生成 Trojan 协议握手头
 * 格式：SHA224(password) + CRLF + CMD(0x01) + ATYP + DST + PORT + CRLF
 */
function buildTrojanHeader(password: string, targetHost: string, targetPort: number): Buffer {
  const passHash = crypto.createHash('sha224').update(password).digest('hex');
  // ATYP: 0x03 = domain name
  const hostBuf = Buffer.from(targetHost);
  const header = Buffer.allocUnsafe(
    56 + 2 + 1 + 1 + 1 + hostBuf.length + 2 + 2
  );
  let offset = 0;
  // SHA224 hex (56 bytes)
  header.write(passHash, offset, 'ascii');
  offset += 56;
  // CRLF
  header[offset++] = 0x0d;
  header[offset++] = 0x0a;
  // CMD: CONNECT (0x01)
  header[offset++] = 0x01;
  // ATYP: domain (0x03)
  header[offset++] = 0x03;
  // domain length
  header[offset++] = hostBuf.length;
  // domain
  hostBuf.copy(header, offset);
  offset += hostBuf.length;
  // port (big-endian)
  header.writeUInt16BE(targetPort, offset);
  offset += 2;
  // CRLF
  header[offset++] = 0x0d;
  header[offset++] = 0x0a;
  return header.subarray(0, offset);
}

/**
 * 建立 Trojan 连接，返回已完成握手的 TLS socket
 * 连接到 targetHost:targetPort（Cursor API 服务器）
 */
export function createTrojanSocket(
  node: TrojanNode,
  targetHost: string,
  targetPort: number
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: node.server,
      port: node.port,
      servername: node.sni,
      rejectUnauthorized: !node.skipCertVerify,
    }, () => {
      // TLS 握手完成，发送 Trojan 头
      const header = buildTrojanHeader(node.password, targetHost, targetPort);
      socket.write(header, (err) => {
        if (err) return reject(err);
        resolve(socket);
      });
    });

    socket.setTimeout(15000);
    socket.on('timeout', () => {
      socket.destroy(new Error('Trojan connect timeout'));
    });
    socket.on('error', reject);
  });
}

/**
 * undici Connector：每次建连时通过 Trojan 节点中转
 * 返回的 connector 可直接传给 undici.Agent({ connect: connector })
 */
export function createTrojanConnector(node: TrojanNode): (opts: any, callback: any) => void {
  return function trojanConnector(opts: any, callback: any) {
    const targetHost = opts.hostname || opts.host;
    const targetPort = opts.port ? parseInt(opts.port, 10) : 443;

    createTrojanSocket(node, targetHost, targetPort)
      .then((socket) => callback(null, socket))
      .catch((err) => callback(err));
  };
}
