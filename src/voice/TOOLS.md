# 规则优先与运行时工具调用

本版将默认兜底从通风分类升级为千问 Function Calling。浏览器的 `routeCommand()` 先完整匹配本地白名单。目标和动作都明确的片段标记为 `high` 并直接交给车辆控制器，缺参数或表达不完整的片段标记为 `low`，其余为 `unmatched`。后两者发送给模型。这里的级别来自规则完整性判定。

混合指令按片段顺序处理。例如「打开左前门，再打开」先通过规则执行左前门动作，仅将「打开」和当前状态交给模型追问。模型接收到的片段包含本轮尚未处理的请求，已完成动作通过工具状态反映。

## 模型和执行器之间的协议

复用 `POST /api/intent`，新增带 `tools` 和 `context` 的请求，字段见 `shared/control.ts`。每次调用从 `ToolRegistry` 获取当前工具定义和状态。后端把定义作为标准 `tools` 参数传给千问，将用户表达和状态作为数据消息传入。模型返回函数名称与参数，后端和浏览器都校验函数及参数，执行器按注册名称分发。

原有只含 `text` 的请求继续支持旧意图分类契约。新语音链路使用工具调用契约。

首版登记 `set_vehicle_part`、`set_vehicle_group` 和 `set_engine_state`，对应现有车辆控制器的三个动作类型。模型参与的车辆变更统一要求一次确认，本地明确规则动作直接执行。只读工具可登记为无需确认。一次模型响应最多接受 8 条调用，按响应顺序执行，结果由实际执行器回报给界面。

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
