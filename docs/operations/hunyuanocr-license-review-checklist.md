# HunyuanOCR 1.5 license review checklist

This packet prepares, but does not make, the human legal decision required before Team AI Box can ship or certify HunyuanOCR 1.5. Technical acceptance is independent from license approval. Until an accountable reviewer records an approval against the exact model revision and license digest, the profile remains Experimental and release distribution stays blocked.

This is an engineering compliance checklist, not legal advice.

## Exact subject

- Model: `tencent/HunyuanOCR`
- Revision: `01b3ec869d704307645d2d8667f01c5bec6fef6d`
- Managed profile: `ocr.hunyuanocr-1.5.bf16-dflash.spark-managed.v2`
- License: Tencent Hunyuan Community License Agreement, release date November 25, 2025
- LICENSE SHA-256: `745adaa59575d2a98b64fd6d3452537b477a6b6edc126f742fc055313cc3d3e0`
- Official pinned LICENSE: <https://huggingface.co/tencent/HunyuanOCR/blob/01b3ec869d704307645d2d8667f01c5bec6fef6d/LICENSE>
- Official pinned DFlash notice: <https://huggingface.co/tencent/HunyuanOCR/blob/01b3ec869d704307645d2d8667f01c5bec6fef6d/dflash/README.md>

The official DFlash README states that HunyuanOCR 1.5, including its DFlash draft, uses the same Tencent Hunyuan Community License. The target and draft therefore form one review subject.

## Intended Team AI Box uses to classify

The reviewer must classify each use independently rather than approving only a generic “local inference” description:

1. A customer-operated appliance with target and DFlash weights preinstalled.
2. An on-premises browser/API service used by the customer’s team.
3. An optional offline model package copied to customer-controlled storage.
4. Export of OCR output and downstream translation or Agent use.

## Mandatory review points

- Territory: determine how sales, deployment, remote access and support are prevented outside the license Territory. The license excludes the European Union, United Kingdom and South Korea.
- Distribution: determine whether each appliance or offline package delivery is a distribution to a third party; if it is, define delivery of the full agreement and the required Notice file.
- Modifications: identify modified upstream files and ensure they carry prominent change notices.
- End-user disclosure: define a prominent disclosure of the actual Team AI Box service provider and a statement that Tencent is not affiliated with, sponsoring or endorsing the product.
- Product terms: incorporate the Section 5(a) and 5(b) restrictions as enforceable provisions and notify downstream recipients.
- Acceptable Use Policy: map the incorporated AUP to product policy, administration, logging and incident response.
- Model improvement: prevent HunyuanOCR outputs from being used to improve non-Hunyuan AI models unless counsel concludes another basis applies.
- Public output: address the AUP requirement for conspicuous machine-generated disclosure when content is placed in a public context.
- Scale: verify the 100,000,000 monthly-active-user threshold and define how it is rechecked for later releases.
- Termination: document how a breach-triggered termination can stop use, remove weights and notify deployed appliances.
- Risk terms: review indemnity, warranty disclaimer, liability limits, Hong Kong law and exclusive jurisdiction.

## Required release artifacts

- A reviewer identity, role, UTC decision time and approval scoped to the exact revision and LICENSE digest.
- Approved product territories and an enforceable territory-control design.
- Approved classification of appliance, hosted-service and offline-package delivery modes.
- The full license text and `deploy/legal/hunyuanocr/NOTICE.template.txt` included in every distribution where required.
- Approved user-facing provider/non-affiliation disclosure and product-terms clauses.
- An operational termination/removal playbook and release-owner sign-off.

## Fail-closed rule

`architecture/validation/hunyuanocr-license-review.v1.json` is intentionally pending. Engineering may retain the explicitly enabled Experimental development route, but must reject Certified promotion, certified-only routing and release shipment of the model weights while any approval field is false. A future approval must be a separately reviewed, digest-bound successor; nobody may edit the pending packet in place to simulate approval.
