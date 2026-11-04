# 规则优先与运行时工具调用

本版将默认兜底从通风分类升级为千问 Function Calling。浏览器的 `routeCommand()` 先完整匹配本地白名单。目标和动作都明确的片段标记为 `high` 并直接交给车辆控制器，缺参数或表达不完整的片段标记为 `low`，其余为 `unmatched`。后两者发送给模型。这里的级别来自规则完整性判定。

混合指令按片段顺序处理。例如「打开左前门，再打开」先通过规则执行左前门动作，仅将「打开」和当前状态交给模型追问。模型接收到的片段包含本轮尚未处理的请求，已完成动作通过工具状态反映。

## 模型和执行器之间的协议

复用 `POST /api/intent`，新增带 `tools` 和 `context` 的请求，字段见 `shared/control.ts`。每次调用从 `ToolRegistry` 获取当前工具定义和状态。后端把定义作为标准 `tools` 参数传给千问，将用户表达和状态作为数据消息传入。模型返回函数名称与参数，后端和浏览器都校验函数及参数，执行器按注册名称分发。

原有只含 `text` 的请求继续支持旧意图分类契约。新语音链路使用工具调用契约。

首版登记 `set_vehicle_part`、`set_vehicle_group` 和 `set_engine_state`，对应现有车辆控制器的三个动作类型。模型参与的车辆变更统一要求一次确认，本地明确规则动作直接执行。只读工具可登记为无需确认。一次模型响应最多接受 8 条独立调用，按响应顺序执行，一个失败后继续执行其余独立项。

## 执行观察与有界 ReAct

`ToolRegistry.execute()` 为每条调用生成独立回执，`runToolCycle()` 将原始调用和全部回执作为 `history` 发回同一接口。后端恢复标准 `assistant.tool_calls` 与逐条 `role: tool` 消息，使用 `tool_call_id` 精确关联，随后请求模型判断重试或给出最终说明。

| 回执字段 | 含义 |
| --- | --- |
| `toolCallId` | 对应本次工具调用的 ID |
| `status` | `succeeded`、`failed` 或 `not_run` |
| `effect` | `applied`、`not_applied` 或 `unknown`，描述是否已产生效果 |
| `error.code`、`error.retryable` | 执行模块给出的错误类别及实际重试资格 |
| `actualState` | 执行后从工具 `context()` 读取的状态；读取失败时省略 |
| `message` | 适合页面及模型理解的简短结果 |

例如三项回执为「左前门成功、车窗成功、后备箱临时失败」，模型可仅返回后备箱原函数和原参数的新调用。执行器校验通过后重试，前两项保持完成。自动重试最多一轮，重试后仍失败就结束并展示部分完成结果。对已确认的原动作重试无需再次确认。

服务端和浏览器都会拦截重放成功动作、改参数、换目标、复用旧调用 ID 及第三次执行。取消、工具注销、不可恢复错误不自动重试。未知副作用仅在工具声明幂等且能读回状态时允许重试。最终数量由实际回执计算；结果复核接口失败时保留已完成项和本地汇总。

模型初次选工具、首次结果判断、重试后总结合计最多 3 次模型请求，各次均计入接口限额。全部成功时也回传结果，但禁止再调用工具。同批仅支持独立动作，有前置依赖的复杂工作流不在本版范围。

## 扩展工具如何报告可恢复错误

执行方法正常返回表示完成；错误默认不自动重试。模块只有确定错误类别时才抛出 `ToolExecutionError`，不要将所有异常都标记为可重试。

```ts
import { ToolExecutionError } from './toolRegistry';

// 确定尚未生效，例如部件被短暂占用。
throw new ToolExecutionError('部件暂时忙。', {
  code: 'PART_BUSY', retryable: true, effect: 'not_applied',
});
```

若超时后是否生效不确定，使用 `effect: 'unknown'`。只有设置目标值这类重复执行仍得到同一结果的工具才能登记 `idempotent: true`，并提供可信的 `context()` 状态读取。切换、累加等工具不能仅为启用重试而声明幂等。

## 新增工具

新增模块提供执行方法后，注册一次工具，下次兜底请求就包含该工具。规则词表、模型响应的名称分发和语音确认状态机沿用现有实现。

```ts
const tools = createVehicleToolRegistry(vehicleController);

const unregister = tools.register({
  definition: {
    type: 'function',
    function: {
      name: 'set_cabin_temperature',
      description: '设置车内空调温度，单位为摄氏度。',
      parameters: {
        type: 'object',
        properties: { celsius: { type: 'number', minimum: 16, maximum: 30 } },
        required: ['celsius'],
        additionalProperties: false,
      },
    },
  },
  confirmation: 'always',
  idempotent: true,
  context: () => ({ celsius: climateController.temperature }),
  prepare(args) {
    const celsius = args.celsius as number;
    return {
      label: `将空调调到${celsius}度`,
      async execute(signal) {
        await climateController.setTemperature(celsius, signal);
        return `空调已调到${celsius}度。`;
      },
    };
  },
});

// 将同一个稳定的 tools 实例传给 VoicePanel。
// 模块卸载时调用 unregister()，旧的待执行调用也会失效。
```

`prepare()` 仅验证并准备动作，实际状态变更放在 `execute()` 内。确认、取消、超时和本轮失效由语音状态机管理。移除工具后，旧响应或待确认批次会被拒绝。当前 Schema 支持对象参数，以及字符串枚举、数值范围、布尔值，最多注册 16 个工具。
