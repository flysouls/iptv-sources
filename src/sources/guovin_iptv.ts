import { collectM3uSource } from "../utils"
import { handle_m3u, ISource, type TSources } from "./utils"

export const guovin_iptv_filter: ISource["filter"] = (
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

export const guovin_iptv_sources: TSources = [
    {
        name: "Guovin/iptv-api",
        f_name: "guovin_iptv",
        url: "https://raw.githubusercontent.com/Guovin/iptv-api/master/output/result.m3u",
        filter: guovin_iptv_filter,
    },
]
