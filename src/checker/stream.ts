import "dotenv/config"

export interface StreamInfo {
    extinf: string
    url: string
}

export interface StreamCheckResult extends StreamInfo {
    available: boolean
    latency: number // ms
}

const DEFAULT_TIMEOUT = 5000
const DEFAULT_CONCURRENCY = 20

const getTimeout = (): number => {
    const envVal = process.env.STREAM_CHECK_TIMEOUT
    return envVal ? parseInt(envVal, 10) : DEFAULT_TIMEOUT
}

const getConcurrency = (): number => {
    const envVal = process.env.STREAM_CHECK_CONCURRENCY
    return envVal ? parseInt(envVal, 10) : DEFAULT_CONCURRENCY
}

/**
 * 检查单个流 URL 是否可用
 * 通过发送 HTTP 请求验证流是否可达
 */
export const checkStreamUrl = async (
    url: string,
    timeout?: number
): Promise<{ available: boolean; latency: number }> => {
    const ms = timeout ?? getTimeout()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)

    const start = Date.now()

    try {
        const res = await fetch(url, {
            method: "GET",
            signal: controller.signal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; IPTVChecker/1.0)",
                Range: "bytes=0-1023", // 只请求前 1KB，避免下载整个流
            },
        })

        const latency = Date.now() - start
        clearTimeout(timer)

        // 2xx 和 3xx 视为可用
        if (res.status >= 200 && res.status < 400) {
            return { available: true, latency }
        }

        return { available: false, latency }
    } catch {
        clearTimeout(timer)
        return { available: false, latency: Date.now() - start }
    }
}

/**
 * 并发批量检测流 URL 可用性
 * @param streams 待检测的流列表
 * @param concurrency 并发数（默认 20）
 * @param onProgress 进度回调
 */
export const checkStreamsBatch = async (
    streams: StreamInfo[],
    concurrency?: number,
    onProgress?: (checked: number, total: number, result: StreamCheckResult) => void
): Promise<StreamCheckResult[]> => {
    const limit = concurrency ?? getConcurrency()
    const results: StreamCheckResult[] = new Array(streams.length)
    let checked = 0
    const total = streams.length

    // 并发池控制
    const execute = async (index: number) => {
        const stream = streams[index]
        const { available, latency } = await checkStreamUrl(stream.url)
        const result: StreamCheckResult = {
            ...stream,
            available,
            latency,
        }
        results[index] = result
        checked++
        onProgress?.(checked, total, result)
    }

    // 分批并发执行
    for (let i = 0; i < streams.length; i += limit) {
        const batch = Array.from(
            { length: Math.min(limit, streams.length - i) },
            (_, j) => execute(i + j)
        )
        await Promise.all(batch)
    }

    return results
}
