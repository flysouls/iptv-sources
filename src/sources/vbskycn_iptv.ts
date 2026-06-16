import { collectM3uSource } from "../utils"
import { handle_m3u, ISource, type TSources } from "./utils"

export const vbskycn_iptv_filter: ISource["filter"] = (
    raw,
    caller,
    collectFn
): [string, number] => {
    const rawArray = handle_m3u(raw)

    if (caller === "normal" && collectFn) {
        for (let i = 1; i < rawArray.length; i += 2) {
            collectM3uSource(rawArray[i], rawArray[i + 1], collectFn)
        }
    }

    return [rawArray.join("\n"), (rawArray.length - 1) / 2]
}

export const vbskycn_iptv_sources: TSources = [
    {
        name: "vbskycn/iptv IPv4",
        f_name: "vbskycn_iptv4",
        url: "https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u",
        filter: vbskycn_iptv_filter,
    },
    {
        name: "vbskycn/iptv IPv6",
        f_name: "vbskycn_iptv6",
        url: "https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv6.m3u",
        filter: vbskycn_iptv_filter,
    },
]
