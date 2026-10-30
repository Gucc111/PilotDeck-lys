# CASE09_NEW 发布评审

## 结论

**不可发布（阻断）。**

`requirements.md` 要求订单小计大于或等于 100 元时免运费，但 `src/shipping.py` 使用严格大于 100 的判断，导致小计正好为 100 元时错误收取 10 元运费。实际单元测试也因此失败。

## 评审范围与文件位置

- 需求：`requirements.md:2`
- 产品实现：`src/shipping.py:2`
- 失败测试：`tests/test_shipping.py:9`
- 本评审报告：`out/release-review.md`

本轮仅评审，没有修改源码或测试。

## 代码审查事实

需求 `requirements.md:2`：订单小计小于 100 元时运费为 10 元；大于或等于 100 元时免运费。

当前实现 `src/shipping.py:2`：

```python
return 0 if subtotal > 100 else 10
```

边界行为：

| 小计 | 需求运费 | 当前实现 | 结果 |
|---:|---:|---:|---|
| 99 | 10 | 10 | 通过 |
| 100 | 0 | 10 | 失败 |
| 101 | 0 | 0 | 通过 |

阻断缺陷：`src/shipping.py:2` 使用 `>`，未实现需求规定的 `>= 100` 免运费规则。

## 真实测试结果

实际执行命令：

```text
python3 -m unittest discover -s tests -v
```

执行环境报告为 Python 3.14.7，退出码为 **1**。

原始逐项结果：

```text
test_above_threshold (test_shipping.ShippingTests.test_above_threshold) ... ok
test_at_threshold (test_shipping.ShippingTests.test_at_threshold) ... FAIL
test_below_threshold (test_shipping.ShippingTests.test_below_threshold) ... ok
```

汇总：

```text
Ran 3 tests in 0.000s
FAILED (failures=1)
```

失败详情：

```text
FAIL: test_at_threshold (test_shipping.ShippingTests.test_at_threshold)
Traceback (most recent call last):
  File ".../release-app/tests/test_shipping.py", line 9, in test_at_threshold
    self.assertEqual(shipping_fee(100), 0)
AssertionError: 10 != 0
```

测试结果为 3 项中 2 项通过、1 项失败；失败项正是需求明确要求检查的 100 元边界。

## 发布判定

**拒绝发布。** 这是核心运费规则的边界错误，并已有真实失败测试证明。修复 `src/shipping.py:2` 的判断后，应重新运行同一测试命令；只有退出码为 0、3 项测试全部通过，才可重新评估发布。

## 事实与推断说明

- 事实：需求规定 `>= 100` 免运费；实现判断为 `> 100`；100 元实际返回 10；测试退出码为 1，且 1 项失败。
- 推断：该错误会使订单小计恰好为 100 元的用户被多收 10 元运费，因此构成发布阻断。
