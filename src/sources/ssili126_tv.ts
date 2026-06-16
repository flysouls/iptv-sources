import { collectM3uSource } from "../utils"
import { handle_m3u, ISource, type TSources } from "./utils"

export const ssili126_tv_filter: ISource["filter"] = (
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

export const ssili126_tv_sources: TSources = [
    {
        name: "ssili126/tv",
        f_name: "ssili126_tv",
        url: "https://raw.githubusercontent.com/ssili126/tv/main/live.m3u",
        filter: ssili126_tv_filter,
    },
]
