import { collectM3uSource } from "../utils"
import { handle_m3u, ISource, type TSources } from "./utils"

export const zhi35_iptv_filter: ISource["filter"] = (
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

export const zhi35_iptv_sources: TSources = [
    {
        name: "zhi35/iptv",
        f_name: "zhi35_iptv",
        url: "https://raw.githubusercontent.com/zhi35/iptv/main/iptv.m3u",
        filter: zhi35_iptv_filter,
    },
]
