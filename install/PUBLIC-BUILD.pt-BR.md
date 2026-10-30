<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.pt-BR.md)
<!-- doc-navigation:end -->

# Construa um dispositivo a partir de uma fonte pública

O novo ponto de entrada da orquestração está documentado em [SOURCE-INSTALL.md](SOURCE-INSTALL.pt-BR.md). Automatiza as receitas abaixo; seu status de verificação completa do dispositivo é indicado lá. Essas receitas manuais permanecem disponíveis para mantenedores e diagnósticos de estágios individuais.

Este é o caminho da origem ao pacote. Ele não importa uma instalação anterior do Team AI Box, seus contêineres, contas, certificados, convidados ou banco de dados. A máquina de construção precisa de acesso à Internet; o pacote completo resultante é instalado offline. O cliente fornece a mídia de instalação do Windows/Linux separadamente.

Use Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 e espaço em disco suficiente para downloads de origem, camadas de construção e o pacote final descompactado. A quantização do modelo também requer uma GPU NVIDIA compatível com memória livre suficiente. Não interrompa outras cargas de trabalho para obter essa memória sem a permissão do proprietário da máquina. Docker e NVIDIA são pré-requisitos, não componentes substituídos pelo instalador.

Execute comandos de um novo checkout público. Defina `BUILD` para um novo diretório de compilação absoluto **fora** do checkout. Os resultados, modelos e relatórios não devem ser confirmados. Todo auxiliar recusa uma saída ocupada, a menos que documente uma operação de retomada específica. Use as referências/IDs do relatório bem-sucedido, e não nomes de imagens copiados da máquina de outra pessoa. Um ID de conteúdo local do Docker não é uma referência de registro para download; Os argumentos pai do Dockerfile precisam da tag local correspondente ou de um resumo upstream qualificado.

## 1. Serviços e aplicativos

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` afeta **compilações** on-line, não a rede de serviço instalada. Os estágios de dependência do nó permitem 2 segundos por tentativa de conexão em vez do padrão do nó de 250 ms. Isso mantém os downloads npm oficiais utilizáveis ​​em links de maior latência, incluindo VPNs gerenciadas pelo usuário, sem alternar registros, desativar o IPv6 ou enfraquecer as verificações de integridade de pacote/TLS. A configuração é um argumento do estágio de construção, não uma alteração de ambiente no aplicativo instalado. Para um link mais lento, as compilações diretas do Docker podem substituir `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. A imagem da web cria suas próprias dependências e ativos bloqueados. Os serviços de nó compartilham o fechamento de dependência de API recém-criado. OCR inclui seu adaptador público; não precisa de um pacote de trabalho não publicado de outro projeto. A tradução usa a imagem vLLM pública fixada NVIDIA. Incorporação, ASR em lote e mídia de transmissão compartilham deliberadamente suas respectivas imagens públicas de tempo de execução. A imagem do computador constrói QEMU 11.1.1 com assinatura verificada com suporte ARM TPM/PPI, KVM, VNC e PulseAudio, preservando os recursos originais do tempo de execução do Windows. O Debian fornece bibliotecas de tempo de execução, mas seu pacote antigo QEMU não deve substituir este executável. A imagem final verifica a propriedade ARM TIS `ppi` e o backend PulseAudio e inclui a ROM do framebuffer RAM correspondente. Consulte [o guia de tempo de execução do computador virtual](../deploy/windows-computer/README.pt-BR.md) para obter a análise de tempo de execução limitada e os requisitos de atualização de preservação de dados.

Cada função possui um log. Um relatório com falha preserva os resultados bem-sucedidos da função; crie apenas a função com falha e mescle os relatórios bem-sucedidos posteriormente. Não substitua um contêiner de desenvolvimento em execução como uma imagem ausente.

## 2. Android sem conta e tempo de execução da câmera

Os bloqueios fixam a compilação AOSP do Google, o pacote host, as entradas do kernel e as revisões de origem. Os downloads são verificados antes do uso. Nenhum convidado é inicializado durante a montagem.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Para o patch do APK da câmera, instale as ferramentas públicas de linha de comando do Android do Google, a plataforma `android-36.1`, as ferramentas de compilação `36.1.0` e uma versão Java com suporte para JDK
8. Defina `ANDROID_SDK_ROOT` and `JDK_HOME` para esses diretórios de ferramentas. As ferramentas são dependências de construção, não perfis de usuário Android exportados. No ARM64 Linux, o pacote `zipalign` do Google pode ser somente x86: instale o pacote ARM64 `zipalign` do Ubuntu e passe `--zipalign /usr/bin/zipalign` abaixo. D8 e apksigner são programas Java. A compilação do APK pode ser executada alternativamente em um host SDK compatível separado; transfira apenas seus dois arquivos de saída (`Camera2.apk`, `camera-preview.json`), nunca as configurações do Android ou o perfil de usuário desse host.

Extraia o APK de estoque da compilação limpa do AOSP (o diretório de saída deve existir e ser gravável pelo contêiner de compilação):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

O APK mantém o **assinante de teste público AOSP** conhecido, e não uma chave de produto privada. O auxiliar verifica o certificado original e resultante e os recursos APK inalterados e remove o material de assinatura temporário. Esta não é uma conta ou identidade de dispositivo Google.

O atual contrato de instalação completo também inclui uma variante experimental do Google Android. Seu bloqueio de entrada pública e inspeção de assinatura **não** concedem certificação do Google ou direitos de redistribuição. Construa/use-o somente dentro dos termos aplicáveis ​​de terceiros; não publique o pacote completo resultante como um download MIT irrestrito.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Arquivos de modelo do editor e receita de quantização pública

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Todos os downloads de modelo usam as revisões imutáveis em `deploy/compute/*profile*` e os hashes Git/LFS do editor. Opcional `--cache <directory>` é somente leitura e aceita arquivos somente quando seus bytes correspondem ao editor. Não é uma forma de importar indiscriminadamente um diretório de modelo instalado. O texto MIT independente do ASR é fixado na versão original do Whisper porque o instantâneo do modelo convertido declara apenas a licença. OCR mantém sua própria licença, não MIT. Os cartões de modelo de tradução e incorporação fixados declaram Apache-2.0 sem enviar seu texto independente; seus ajudantes incluem a licença Apache fixada por soma de verificação e um registro de procedência após verificar essa declaração.

Um download correspondente interrompido suporta `--resume`. `--transfer ranges` usa intervalos HTTP retomáveis ​​limitados; `--transfer huggingface` requer os pacotes oficiais `huggingface_hub`/`hf_xet` e desativa o uso de token. Os caches parciais e de download permanecem fora dos diretórios de modelos publicáveis. As somas de verificação são obrigatórias em todos os transportes. Não os enfraqueça para páginas de login/desafio HTML ou downloads truncados.

A quantização é executada off-line em um contêiner de construção separado usando dados públicos de calibração sintética do ModelOpt, nunca históricos de bate-papo. Somente saídas cujo `build.json` diz `quantized` podem fornecer `assistant-model` and `translation-model`; selecione seus subdiretórios `model/`, não fontes brutas ou todo o espaço de trabalho de construção. Depois de validar as entradas, as compilações do Linux aconselham o kernel a liberar as páginas em cache desses arquivos específicos. Isso evita leituras enganosas de memória GPU imediatamente livres na memória compartilhada do GB10; ele não exclui pesos, limpa caches de todo o host nem interrompe cargas de trabalho. Para uma GPU GB10, o auxiliar orçamenta o Linux `MemAvailable` e reserva capacidade para calibração e host. Ele recusa capacidade insuficiente em vez de aceitar silenciosamente uma construção baseada principalmente em CPU. Quando o modelo completo se ajusta, os orçamentos ModelOpt explícitos evitam o caminho desnecessário de exportação de descarregamento de CPU do Accelerate. O contêiner de compilação também define memória bloqueada ilimitada e uma pilha de 64 MiB, seguindo os [NVIDIArequisitos de lançamento de quantização](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Essas configurações têm como escopo o contêiner de build e não os limites de todo o host.

## 4. Entradas completas do pacote

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

A fusão deve relatar **41 funções e nenhuma função faltante**. Ele verifica a arquitetura da imagem/IDs de conteúdo e rejeita saídas conflitantes. Os recursos contêm apenas firmware UEFI upstream (incluindo um novo modelo de armazenamento de variáveis), um ISO de driver virtio fixado por soma de verificação, tempo de execução de desenho de origem e avisos do Android vinculados às imagens recém-construídas. O ISO não é uma mídia de instalação do Windows. Seu espelho Microsoft OpenVMM idêntico à soma de verificação evita depender de uma página de download interativa do Fedora.

Colete pacotes de host com `collect_host_packages.py` conforme descrito em [README.md](README.pt-BR.md) e, em seguida, gere o modelo com `prepare-release.py --template`. Preencha seu mapa de imagem de `images.json`; preencha todas as 12 funções de ativos das saídas do modelo, `resources/assets.json` and `guest-tools`. Defina `sourceCommit` para o checkout e a versão real do agente. Nenhum espaço reservado ou configuração de instalação anterior é aceitável.

Execute `prepare-release.py --inputs … --output …` e, em seguida, `build-package.sh` usando essa versão preparada. Fontes modificadas/não confirmadas requerem o sinalizador de candidato `--allow-working-tree` explícito; eles não são um commit liberado. Consulte [PACKAGE-README.md](PACKAGE-README.pt-BR.md) para instalação. Um novo banco de dados de contas em branco obtém `admin/admin`; todas as credenciais de serviço e identidade do dispositivo são geradas de forma independente. As compilações por si só não provam que a instalação foi bem-sucedida.

## Receitas históricas em camadas e verificações de publicação

Dockerfiles de diagnóstico/em camadas mais antigos são retidos para manutenção de origem, não usados por este pipeline. Seus argumentos `BUILD_PARENT_N` intencionalmente não têm imagem privada padrão. Forneça um pai compatível que você construiu ou use o pipeline público acima; não adivinhe um resumo de desenvolvimento indisponível.

Antes de publicar, execute o protetor de origem e o scanner secreto, revise o histórico separadamente e exclua todos os diretórios de construção, pacotes, discos convidados, dados de conta e o site privado. Os relatórios que contêm caminhos locais pertencem fora da árvore pública. A verificação para este trabalho é limitada ao fechamento de entrada do build, identidade do artefato, instalação e caminhos de serviço mínimos recém-instalados; ele não executa novamente a aceitação de negócios não relacionados.
