import { DISCOVERY_REPORT_PROMPT } from "./prompts";
import { REPORT_START_MARKER } from "./presentation";

// The decision and evidence rules are identical to v13. Only its final
// presentation paragraph changes; the legacy path remains byte-for-byte intact.
export const DISCOVERY_CARDS_REPORT_PROMPT = DISCOVERY_REPORT_PROMPT.slice(0, DISCOVERY_REPORT_PROMPT.indexOf("目标6—8个不同赛事")) + `目标6—8个不同赛事，同赛不同赛道不重复；不足少给并说明，可无可靠推荐。不强凑近期组，区分近期/提前准备。先完成必要比较与核查，再依次交付完整画像、每项完整推荐、结语。每项必须含具体任务、与真实回答的匹配理由、价值成果、缺口/资格和依据；保留信息，省去重复铺陈。平台会按competitionId附上本次目录中的通用赛事资料及站内详情链接，无需复述整份通用资料；但与本人相关的资格例外、费用/线上底线、待核条件必须明确。不得用目录介绍代替个性化分析。
事实边界适用于所有可见字段，包括profile、summary、timing、reasons、value和conclusion，不只conditions。未确认、未提供或未勾选不等于没有、缺少或尚未掌握；不得把兴趣、意愿或建议任务写成既有能力。历史条目为pending_review、imported_unrechecked或legacy_import时，即使原文含“已核”“已确认”，也只是原历史记录，不得升级为本次已核或当届确定事实；按原届次与状态表述。没有赛事结束或下届发布的同范围证据，写“本次未查到结束信息／下届通知”，不写“本届已结束／下届尚未发布”。已有作品、原型和队伍只是准备起点；旧作复用规则、队伍人数／同校／成员学段未核时，摘要或优先建议若以这些条件说明适配，也须明确“复用待核／队伍构成待核”，不能让详情中的待核变成摘要的确定可用或相容结论。保留会改变判断的关键限制，其他说明不重复铺陈。
最终回答使用逐行JSON文本，不用代码围栏或Markdown标题。第一行必须单独写：${REPORT_START_MARKER}
随后每行一个完整JSON对象，字符串内换行写成\\n。顺序严格为一个profile、零到多条card、一个conclusion。不要输出协议之外的解释，不输出内部推理、工具计划、字段注释或占位示例。
profile结构：{"type":"profile","summary":"80—120字真实画像概述","groups":{"background":["背景事实短语"],"goals":["本人目标短语"],"experience":["有依据的已有任务或能力短语"],"constraints":["时间、队伍、资源、预算与方式短语"]}}。groups用于去重的短语标签，每项通常6—16字，必要限定可更长；只保留有区分度的真实事实，不逐字复述13栏，不在多组重复同一事实，不强凑标签数量。保留“及以上／未知／自述／目标优先级／个人全程总预算／只接受全程线上”等会改变判断的限定；复合选项只能中性概括，不能拆成每个子项均已具备。赛事特定的年龄、注册时点、同校等未确认条件留在对应card.conditions，不逐项堆入画像。简短展示不删减参与匹配的真实回答，相关具体事实仍用于个性化理由。
card结构：{"type":"card","key":"r1","competitionId":"目录id或null","title":"赛事名称","track":"具体赛道或任务，无具体赛道可空字符串","summary":"一句个性化理由","timing":"有依据的时机或关键待核提示","details":{"tasks":["具体任务"],"reasons":["关联真实回答的理由，保持不同维度2—4条"],"value":["成果与价值"],"conditions":["本人需要核对的资格、条件、费用、方式及缺口，不能省掉例外"]},"sources":[{"url":"输入或本次工具返回的完整真实URL","title":"来源名称及必要届次"}]}。key依次r1/r2且唯一。库内competitionId逐字取目录id，库外用JSON null；不是字符串null。不得生成catalogDetail，它由平台补充。sources只列支持本项的真实依据，URL不编造；未知事实明确待核，不用来源数量冒充可靠性。
conclusion结构：{"type":"conclusion","priorities":[{"cardKey":"已输出推荐的key","reason":"点名该赛事并说明优先理由"}],"note":"必要的整体说明或推荐不足原因","exceptions":["至多两项已知冲突例外及明确冲突"]}。有可靠推荐时选一两个优先，不重新排序或增补名单；例外不占正式卡片。无可靠推荐时不输出card，priorities与exceptions为空，note明确说明依据不足及未知不等于没有能力，不能以泛探索虚构推荐，不追加问题。
只输出这一份展示记录，平台负责生成可复制的中文报告。不得另写重复全文、长备赛计划或邀请聊天。`;
