<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.pt-BR.md)
<!-- doc-navigation:end -->

# Escopo da licença e avisos de terceiros

Direitos autorais © 2026 Weerocks LLC. A [MIT licença](LICENSE) raiz cobre o código original Team AI Box e a documentação autorizada por seu proprietário. Ela não licencia novamente código de terceiros, arquivos upstream copiados/modificados, dependências, modelos, firmware, sistemas operacionais, fontes ou imagens. Os arquivos de copyright, LICENSE e NOTICE existentes têm precedência para seus respectivos materiais. Os metadados do pacote `license: MIT` referem-se ao código original desse pacote, e não a tudo incluído em uma imagem implantada. `private: true` é retido para evitar publicação acidental no registro do pacote; não revoga a concessão MIT.

## Inventário

O [inventário de componentes](docs/open-source/components.json) legível por máquina registra versões ou fontes de versões, evidências de licenciamento, escopo de redistribuição e obrigações binárias não resolvidas. [Inventário de dependência](docs/open-source/dependencies.json) é gerado a partir do arquivo de bloqueio, metadados de dependência instalados, módulos Go e arquivos de requisitos Python. Os metadados de licença ausentes são explicitamente desconhecidos e não são assumidos MIT. Regenere-o com `python3 tools/open_source_inventory.py`.

| Componente/material | Limite da licença | Requisitos de distribuição |
| --- | --- | --- |
| Receptor UxPlay e `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Retenha GPL, avisos, fonte upstream exata, patches e crie scripts com qualquer binário receptor; apenas vincular ao upstream é insuficiente para uma versão binária. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Guarde os avisos e disponibilize os arquivos de origem cobertos modificados. |
| GStreamer | Licenças LGPL e plugins individuais | Inspecione o conjunto real de plug-ins e cumpra as obrigações correspondentes. |
| SDK do servidor/navegador LiveKit | Apache-2.0 | Retenha os direitos autorais, a licença e o AVISO aplicável. |
| Chocos / AOSP | Apache-2.0 e licenças por arquivo, incluindo kernel GPL | Preservar os avisos upstream e a fonte correspondente aplicável. AOSP não inclui uma licença de serviços do Google. |
| Drivers QEMU / Linux / EDK II / virtio | Licenças por projeto e por arquivo | Audite a construção binária, firmware e drivers reais; não coloque rótulo geral MIT. |
| Guacamole | Apache-2.0 | Preserve a LICENÇA e o AVISO copiados pelo Dockerfile do plug-in de computador. |
| Árvore de dependências Node/React/Vite e JS | Licenças por pacote | Preservar avisos de dependência ao distribuir saída agrupada. |
| PostgreSQL e pacotes de sistema operacional contêiner | PostgreSQL / por pacote | Inclui registros de licença de pacote instalado em uma versão binária. |
| PyMuPDF / MuPDF usado por OCR | AGPL-3.0-or-later ou licença comercial | A distribuição/serviço combinado do trabalhador de OCR não é geral MIT; cumprir as obrigações da AGPL ou obter direitos comerciais. O código original pode manter sua concessão MIT. |
| Ativos do modelo Qwen / LMT / Whisper / FLUX | Termos exatos do modelo | Os modelos são separados da concessão de origem MIT. Os termos FLUX **4B** não devem ser substituídos por outro modelo FLUX. |
| Pesos HunyuanOCR | Licença da comunidade Tencent Hunyuan | Licença de modelo condicional; revise os termos de destinatário, território, uso, atribuição e redistribuição para cada versão. |
| NVIDIA software | NVIDIA e incluiu termos de terceiros | A instalação existente do Docker/NVIDIA do host não é redistribuída por este pacote de origem. Bibliotecas CUDA/contêiner agrupadas ainda precisam de sua própria revisão. |
| Serviços móveis do Google / Play Store | Proprietário | Não faz parte do candidato de fonte pública. O código de integração em tempo de execução não concede direitos para distribuir imagens GMS. |
| Mídia de instalação do Windows, discos convidados, contas | Não coberto | Os usuários fornecem mídia e licenças ISO autorizadas. Nunca envie discos de VM de teste ou estado de convidado conectado. |
| SDK ViKey aposentado | Subvenção proprietária/sem concessão pública estabelecida | SDK removido da fonte de trabalho; commits históricos privados e cópias retidas do SDK não devem ser publicados. Nenhuma chave USB é necessária. |

Os avisos de transmissão exatos permanecem em [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). Os avisos de transporte ADB permanecem ao lado do cliente telefônico. Não os remova durante a minificação ou embalagem. O isolamento do contêiner por si só não cancela as obrigações de copyleft. A análise de distribuição depende do artefato combinado real.

## Marca e colaboradores

MIT concede permissão de direitos autorais, não direitos de marca registrada ou endosso. Os nomes/logotipos Team AI Box e Weerocks não devem implicar suporte oficial para um produto modificado. NVIDIA, DGX Spark, Android, Google Play, Windows e Apple/AirPlay pertencem aos seus respectivos proprietários. Compatibilidade não é certificação.

Os metadados do autor local são um inventário, não uma prova de atribuição de direitos autorais. As categorias de propriedade revisadas são registradas em [OWNERSHIP.md](docs/open-source/OWNERSHIP.pt-BR.md). A autorização do proprietário do projeto aplica-se às suas contribuições originais; os contribuidores devem enviar apenas trabalhos que tenham direito à licença. Suspeita de atribuição ausente: teamaibox@weerocks.llc.
