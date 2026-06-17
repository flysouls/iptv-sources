import "dotenv/config"
import fs from "fs"
import path from "path"
import { hrtime } from "process"

import { handle_m3u } from "./sources/utils"
import { m3u2txt } from "./utils/m3u2txt"
import { checkStreamsBatch, type StreamInfo } from "./checker/stream"

// 远程聚合源地址
const AGGREGATED_URL =
    process.env.AGGREGATED_URL || "https://gitpage.flysoul.cool/aggregated"

const OUTPUT_DIR = path.resolve("verified")

/**
 * 从远程拉取聚合 M3U 数据
 */
const fetchAggregated = async (url: string): Promise<string> => {
    console.log(`[VERIFY] Fetching aggregated data from ${url}`)
    const res = await fetch(url)
    if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
    }
    const text = await res.text()
    console.log(`[VERIFY] Fetched ${(text.length / 1024).toFixed(1)} KB`)
    return text
}

/**
 * 解析 M3U 为 [{extinf, url}] 对
 */
const parseM3u = (m3u: string): StreamInfo[] => {
    const lines = handle_m3u(m3u)
    const entries: StreamInfo[] = []

    for (let i = 1; i < lines.length; i += 2) {
        if (lines[i] && lines[i + 1]) {
            entries.push({ extinf: lines[i], url: lines[i + 1] })
        }
    }

    return entries
}

/**
 * 主逻辑：拉取 → 检测 → 输出
 */
const verify = async () => {
    const startTime = hrtime.bigint()

    // 1. 拉取远程聚合数据
    let m3uContent: string
    try {
        m3uContent = await fetchAggregated(AGGREGATED_URL)
    } catch (e) {
        console.error(`[VERIFY] Failed to fetch aggregated data: ${e}`)
        console.log("[VERIFY] Falling back to local m3u/aggregated.m3u")
        const localPath = path.resolve("m3u", "aggregated.m3u")
        if (fs.existsSync(localPath)) {
            m3uContent = fs.readFileSync(localPath, "utf-8")
        } else {
            console.error("[VERIFY] No local fallback either, aborting.")
            process.exit(1)
        }
    }

    // 2. 解析频道
    const streams = parseM3u(m3uContent)
    console.log(`[VERIFY] Parsed ${streams.length} channels, starting stream check...`)

    // 3. 本地网络批量检测
    const results = await checkStreamsBatch(
        streams,
        1000,
        (checked, total) => {
            if (checked % 200 === 0 || checked === total) {
                console.log(`[VERIFY] Progress: ${checked}/${total}`)
            }
        }
    )

    const elapsed =
        (parseInt(hrtime.bigint().toString()) - parseInt(startTime.toString())) / 1e6

    // 4. 过滤出可用的频道
    const available = results.filter((r) => r.available)
    console.log(
        `[VERIFY] Check done in ${elapsed.toFixed(0)}ms: ${available.length}/${results.length} channels available`
    )

    // 5. 输出到 verified/
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    }
    const txtDir = path.join(OUTPUT_DIR, "txt")
    if (!fs.existsSync(txtDir)) {
        fs.mkdirSync(txtDir, { recursive: true })
    }

    // M3U 格式
    const m3uLines: string[] = ["#EXTM3U"]
    for (const ch of available) {
        m3uLines.push(ch.extinf)
        m3uLines.push(ch.url)
    }
    const m3uOut = m3uLines.join("\n")
    fs.writeFileSync(path.join(OUTPUT_DIR, "cn.m3u"), m3uOut)
    fs.writeFileSync(path.join(OUTPUT_DIR, "cn"), m3uOut)

    // TXT 格式
    const txtOut = m3u2txt(m3uLines)
    fs.writeFileSync(path.join(txtDir, "cn.txt"), txtOut)
    fs.writeFileSync(path.join(txtDir, "cn"), txtOut)

    console.log(`[VERIFY] Written verified/cn.m3u + verified/cn + verified/txt/cn.txt + verified/txt/cn`)
    console.log(`[VERIFY] Done! ${available.length} verified channels ready.`)
}

verify()
    .then(() => {
        process.exit(0)
    })
    .catch((e) => {
        console.error(e)
        process.exit(1)
    })
