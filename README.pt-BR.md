<!-- Generated from docs/readme-locales/ and docs/readme-features/pt-BR.json by tools/render-readmes.mjs. -->
# Team AI Box — Software de código aberto para NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Transforme seu NVIDIA DGX Spark no espaço de IA da sua equipe.** Execute IA local, geração de imagens e ferramentas de documentos no NVIDIA DGX Spark. O Team AI Box reúne arquivos da equipe, mensagens e dispositivos virtuais em um espaço de código aberto no navegador.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[Lista completa de funcionalidades](#features) · [Instalar em um DGX Spark novo](#install) · [Construa com a gente](#contribute)

## Por que Team AI Box?

- **Um espaço integrado:** interface e contas consistentes para IA, colaboração e dispositivos.
- **IA local em primeiro lugar.** Execute a inferência no seu Spark e conecte APIs de modelos externos se desejar.
- **Feito para DGX Spark.** Instale no Ubuntu ARM64 com contêineres GPU NVIDIA e virtualização KVM.
- **Aberto a melhorias:** código próprio MIT, 17 idiomas, temas claro/escuro e escolhas manuais persistentes. O padrão é inglês.

## O espaço de trabalho real

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/pt-BR/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/pt-BR/workbench-light.jpg">
  <img src="docs/assets/screenshots/pt-BR/workbench-light.jpg" alt="Espaço Team AI Box para NVIDIA DGX Spark com aplicativos de IA e ferramentas de equipe — Português" width="1280">
</picture>

[Tema claro](docs/assets/screenshots/pt-BR/workbench-light.jpg) · [Tema escuro](docs/assets/screenshots/pt-BR/workbench-dark.jpg)

<a id="features"></a>

## Lista completa de funcionalidades

**Ir para um módulo**

- [Área de trabalho e navegação diária](#feature-workspace)
- [Assistente de IA e fluxos controlados de agentes](#feature-assistant)
- [Geração de imagens com IA](#feature-drawing)
- [Reconhecimento e correção de texto](#feature-ocr)
- [Transcrição de fala gravada e ao vivo](#feature-transcription)
- [Tradução de textos, arquivos e mídia](#feature-translation)
- [Mensagens da equipe](#feature-messaging)
- [Drive da equipe e colaboração com arquivos](#feature-drive)
- [Transmissão sem fio compatível com AirPlay](#feature-casting)
- [Celulares Android virtuais persistentes](#feature-phones)
- [Computadores virtuais Windows e Linux](#feature-computers)
- [Administração, permissões e segurança](#feature-administration)
- [Instalação a partir do código-fonte e manutenção](#feature-installation)
- [Desenvolvimento de código aberto e extensões](#feature-developers)

<a id="feature-workspace"></a>

### Área de trabalho e navegação diária

- Use uma única área de trabalho no navegador para IA local, colaboração em equipe e dispositivos virtuais em um único DGX Spark.
- Explore aplicativos por categoria, pesquise no catálogo e abra um aplicativo pela barra lateral.
- Veja o carregamento, a disponibilidade e o estado do serviço de cada aplicativo.
- Acompanhe trabalhos na fila, em execução, concluídos, com falha e cancelados na central de tarefas; abra os resultados disponíveis.
- Veja os convites de transmissão pendentes no menu de notificações e abra o aplicativo de transmissão para responder.
- Escolha entre 17 idiomas da interface, incluindo árabe da direita para a esquerda; o inglês é o padrão até você escolher outro idioma.
- Use aparência clara, escura ou do sistema; mantenha suas escolhas manuais de idioma e tema ao atualizar, entrar novamente e acessar os aplicativos.

<a id="feature-assistant"></a>

### Assistente de IA e fluxos controlados de agentes

- Inicie conversas, salve o histórico e reabra discussões anteriores.
- Escolha o modo Automático, Resposta ou Agente para a solicitação atual.
- Anexe vários arquivos a uma solicitação e remova anexos antes de enviar.
- Leia respostas à medida que são geradas, interrompa uma execução ativa e retome seu fluxo de eventos após reconectar.
- Consulte os detalhes do modelo retornados, a atividade das ferramentas, as fontes e o uso; baixe os artefatos quando uma execução os produzir.
- Revise o escopo de uma ação do Agente que exige confirmação e, em seguida, aprove ou negue essa ação.
- Execute o trabalho do Agente em um ambiente isolado por usuário, com área de trabalho persistente; ferramentas e acesso à rede seguem a política do administrador.

<a id="feature-drawing"></a>

### Geração de imagens com IA

- Gere uma imagem a partir de uma descrição textual usando o modelo de imagem disponível; o aplicativo atual não é um editor de imagens nem de preenchimento de regiões.
- Escolha a intenção de geração Automática ou Rápida quando a configuração do modelo disponível oferecer suporte.
- Selecione proporções quadradas, horizontais ou verticais, dimensões de saída compatíveis e uma semente aleatória ou fixa.
- Solicite saída PNG, WebP ou JPEG, visualize o resultado e baixe a imagem.
- Acompanhe a fila e o progresso da geração, cancele trabalhos e recupere a tarefa atual após reabrir a página.
- Consulte o modelo realmente utilizado e os parâmetros de geração registrados com o resultado.

<a id="feature-ocr"></a>

### Reconhecimento e correção de texto

- Envie um arquivo PNG, JPEG, WebP ou PDF, ou escolha um arquivo existente no drive da equipe.
- Informe um idioma como referência e reconheça texto, tabelas Markdown ou fórmulas LaTeX dentro das capacidades do modelo selecionado.
- Revise os resultados do reconhecimento por página e bloco de texto e corrija manualmente o texto reconhecido.
- Exporte o conteúdo revisado como texto, Markdown ou JSON.
- Envie um resultado de reconhecimento armazenado para Tradução sem reenviar nem reconhecer novamente o arquivo de origem.
- Acompanhe e cancele tarefas de reconhecimento. O modelo atual não fornece coordenadas de caixas delimitadoras nem pontuações de confiança.

<a id="feature-transcription"></a>

### Transcrição de fala gravada e ao vivo

- Escolha áudio ou vídeo local ou do drive da equipe: WAV, FLAC, OGG, WebM, MP3, M4A, AIFF ou MP4.
- Pré-visualize a mídia de origem e use a detecção automática de idioma ou indique um idioma compatível.
- Revise os segmentos transcritos com marcações de tempo e edite seus textos.
- Exporte texto, JSON ou legendas SRT ou WebVTT.
- Encaminhe uma transcrição armazenada para Tradução e acompanhe ou cancele a tarefa de transcrição atual.
- Transcreva o áudio do microfone ao vivo quando HTTPS, a permissão do navegador, MediaRecorder e o serviço em tempo real estiverem disponíveis.
- Use marcações de tempo por palavra ou separação de falantes apenas com perfis compatíveis; o fluxo experimental de separação de falantes exige entrada WAV.

<a id="feature-translation"></a>

### Tradução de textos, arquivos e mídia

- Selecione no catálogo de 60 idiomas oferecidos pelo modelo, detecte automaticamente o idioma de origem ou escolha e inverta os idiomas de origem e destino. Isso não garante a mesma qualidade para todos os pares de idiomas.
- Traduza texto digitado ou colado e compare os segmentos originais e traduzidos.
- Envie uma imagem ou um PDF, ou selecione-o no drive da equipe; reconheça seu texto antes da tradução quando o OCR estiver pronto.
- Traduza áudio ou vídeo compatível por meio da transcrição, preservando os tempos dos segmentos quando o serviço de transcrição estiver pronto.
- Reutilize resultados armazenados de OCR ou transcrição e baixe os resultados intermediários disponíveis.
- Edite o texto traduzido e exporte texto, Markdown ou JSON; os resultados de áudio e vídeo também permitem SRT e WebVTT.
- Acompanhe as etapas de extração, transcrição e tradução, cancele trabalhos e recupere a tarefa atual ao reabrir a página.
- Os idiomas de tradução são independentes da cobertura de idiomas da interface e de OCR/ASR. A tradução de PDF é baseada em texto, não recria o layout original nem oferece edição geral de DOCX/XLSX.

<a id="feature-messaging"></a>

### Mensagens da equipe

- Encontre colegas, inicie conversas diretas e crie grupos com nome e membros selecionados.
- Filtre todas as conversas, as não lidas ou os grupos e pesquise conversas e mensagens às quais você tem acesso.
- Envie texto e anexos de arquivos; baixe a versão original do arquivo anexado.
- Receba mensagens em tempo real, recupere o histórico ao reconectar, acompanhe as posições de leitura e veja a presença dos membros.
- Envie com Enter, insira uma nova linha com Shift+Enter e alterne entre a lista de conversas e a conversa em telas estreitas.
- Exclua uma mensagem apenas da sua visualização ou limpe seu próprio histórico; os registros dos outros participantes não são excluídos.
- Exclua uma conversa da sua própria lista sem sair do grupo; uma nova mensagem pode fazê-la reaparecer.

<a id="feature-drive"></a>

### Drive da equipe e colaboração com arquivos

- Organize espaços de arquivos pessoais e de equipe com pastas e navegação por caminhos.
- Alterne entre lista e grade, consulte detalhes dos arquivos, pesquise arquivos e pastas e veja alterações recentes.
- Envie vários arquivos, acompanhe o progresso e cancele um envio.
- Retome o envio de um arquivo grande em partes selecionando o mesmo arquivo novamente; o servidor verifica as partes enviadas.
- Crie pastas e renomeie, mova ou copie arquivos e pastas.
- Pré-visualize imagens, áudio, vídeo, texto e PDFs compatíveis e baixe arquivos; a reprodução de mídia depende do navegador.
- Envie uma nova versão de arquivo, consulte o histórico de versões e baixe versões anteriores.
- Mova itens para a lixeira e restaure-os.
- Compartilhe internamente com membros ou equipes usando permissões de visualização ou edição e validade opcional; não se trata de compartilhamento anônimo por link público.
- Navegue pelos arquivos e pastas compartilhados com você, com o acesso revalidado conforme as permissões e os vínculos atuais.

<a id="feature-casting"></a>

### Transmissão sem fio compatível com AirPlay

- Inicie e pare um receptor temporário para dispositivos Apple compatíveis na mesma rede local, com nome e PIN próprios.
- Escolha uma duração de 15, 30, 60 ou 120 minutos para o receptor; ao parar ou expirar, sua divulgação na rede e o acesso à visualização são encerrados.
- Restrinja a visualização a você, a membros selecionados ou a uma equipe; convide espectadores, que podem aceitar ou recusar.
- Assista à tela e reproduza áudio no navegador; as regras de reprodução automática podem exigir um clique para habilitar o som.
- Veja e remova espectadores conectados; um administrador pode parar uma sessão sem receber permissão para assistir a conteúdo privado.
- Veja os estados de desconexão e reconexão e tenha a permissão de visualização revalidada ao entrar novamente.
- Exige um serviço de mídia pronto, descoberta acessível na rede local e versões compatíveis de navegador e dispositivo. A visualização no navegador não oferece saída HDMI, reprodução DRM/FairPlay nem certificação Apple.

<a id="feature-phones"></a>

### Celulares Android virtuais persistentes

- Crie celulares Android independentes a partir dos perfis de sistema instalados, preservando os aplicativos e dados de cada celular entre sessões.
- Inicie, desligue, reinicie, renomeie e exclua explicitamente celulares individuais.
- Controle o Android com teclado e ponteiro e com os botões Voltar, Início, Aplicativos recentes e volume.
- Use áudio e tela cheia, reconecte ou transfira a conexão ativa do celular para outra página.
- Envie arquivos para um celular e baixe arquivos da pasta de transferência Team AI Box dele.
- Instale seus próprios arquivos APK após confirmação; as permissões dos aplicativos Android não são concedidas silenciosamente.
- Forneça uma imagem, vídeo ou câmera do navegador à câmera virtual quando houver suporte; câmeras USB físicas e fontes de rede também exigem configuração e permissões do administrador.
- Autorize temporariamente a depuração ADB restrita ao dispositivo por um retransmissor de curta duração, usando ferramentas ADB padrão e o cliente de retransmissão Node.js.
- Consulte sob demanda estatísticas de taxa de quadros, perda de pacotes e tempo de ida e volta da conexão; elas não garantem a latência de ponta a ponta.
- Escolha um perfil de sistema Google Play apenas quando seus recursos estiverem disponíveis; disponibilidade não significa certificação Play Protect nem garantia de funcionamento de todos os aplicativos Android.

<a id="feature-computers"></a>

### Computadores virtuais Windows e Linux

- Crie computadores ARM64 Windows/Linux independentes com quantidades selecionadas de CPU, memória e disco.
- Inicie um computador, desligue-o normalmente e exclua um computador desligado após confirmação explícita.
- Abra um monitor virtual no navegador para ver firmware, inicialização, instalação e telas do sistema operacional sem primeiro entrar em uma área de trabalho remota.
- Use teclado, ponteiro, som, tela cheia e controles de reconexão.
- Abra o mesmo computador virtual em várias abas ou janelas do navegador.
- Convide colegas para visualizar ou controlar um monitor e revogue o acesso deles.
- Transfira o controle a outro participante, libere-o ou recupere-o como proprietário; selecione o modo de controle único ou compartilhado.
- Envie uma ISO de instalação com controles de pausa, retomada e cancelamento ou selecione uma ISO existente no drive pessoal ou da equipe.
- Monte ou ejete mídia óptica virtual e selecione uma inicialização única pelo disco; alterar a mídia não reinicia o computador automaticamente.
- Instale seu próprio sistema operacional ARM64 autorizado e use, separadamente, a área de trabalho remota opcional. O licenciamento do Windows continua sendo sua responsabilidade; não estão incluídos Windows pré-ativado nem suporte geral a sistemas convidados x86.

<a id="feature-administration"></a>

### Administração, permissões e segurança

- Crie membros locais, gerencie o estado das contas e redefina senhas quando sua função permitir.
- Atribua funções integradas, consulte permissões e gerencie membros da equipe com proteções para operações do proprietário.
- Filtre eventos de auditoria por domínio ou ID de correlação, consulte detalhes e solicite a verificação da integridade do histórico de auditoria.
- Consulte o estado do equipamento, dos aplicativos, do armazenamento e dos serviços de execução na área de administração.
- Configure provedores externos de IA e mapeamentos de modelos e operações, substitua credenciais e habilite ou desabilite provedores.
- Defina políticas permitidas de roteamento local ou externo com aprovação explícita para processamento externo; a IA local não exige uma chave de API externa.
- Consulte os perfis de modelos instalados, as versões dos ambientes de execução, a disponibilidade e os detalhes de validação.
- Importe pacotes de plugins verificados e gerencie instalação, atualização, habilitação, desabilitação e remoção dos plugins elegíveis; plugins oficiais protegidos têm restrições.
- Consulte filas e tarefas de execução, ajuste políticas de agendamento permitidas e cancele trabalhos elegíveis.
- Consulte as configurações de armazenamento criptografado e proteção na inicialização. O desbloqueio automático usa uma chave local; ativar uma frase secreta na inicialização requer verificação de recuperação e confirmação.

<a id="feature-installation"></a>

### Instalação a partir do código-fonte e manutenção

- Instale a partir de um clone Git público com um único comando documentado de instalação pelo código-fonte em um DGX Spark novo e compatível.
- Prepare ferramentas de compilação, baixe os arquivos necessários de modelos e ambientes de execução, construa imagens dos aplicativos, empacote e instale reutilizando o ambiente Docker/NVIDIA existente.
- Retome uma preparação interrompida com o mesmo comando e diretório de trabalho, reutilizando downloads verificados e etapas concluídas.
- Execute verificações de pré-requisitos, preparação somente para download ou criação de pacote somente por compilação.
- Prepare um pacote portátil completo para instalação em um destino sem internet; a preparação a partir do código-fonte exige acesso à rede.
- Verifique os arquivos fixados e use fontes alternativas documentadas ou caches portáteis verificados quando necessário; nenhum espelho de terceiros é garantido.
- Inicialize credenciais novas e específicas do equipamento e a conta documentada admin/admin; depois altere sua senha. Não copie contas nem discos de máquinas virtuais de outro equipamento.
- Revise candidatos à manutenção, resultados de compatibilidade, planos explícitos de execução e seu histórico, com instruções delimitadas de reversão e recuperação — não atualizações automáticas arbitrárias do sistema operacional ou de drivers.

<a id="feature-developers"></a>

### Desenvolvimento de código aberto e extensões

- Leia, modifique e redistribua o código e a documentação originais do produto sob a licença MIT; componentes de terceiros mantêm suas próprias licenças.
- Crie extensões ApplicationPlugin ou ComputePlugin usando os contratos públicos do SDK e os plugins de exemplo incluídos.
- Use manifestos de pacotes assinados e verificações de integridade e permissões para importar plugins; isso não implica a existência de um marketplace público de plugins.
- Contribua com correções, traduções, documentação e integrações por meio de issues e pull requests; use o canal privado de segurança para relatar vulnerabilidades.

## O que é o NVIDIA DGX Spark?

O NVIDIA DGX Spark é um sistema compacto de IA para desktop com o superchip GB10 Grace Blackwell. A configuração de 128 GB combina CPU Arm de 20 núcleos, GPU Blackwell e 128 GB de memória unificada do sistema, com largura de banda de 273 GB/s. A NVIDIA informa até 1 PFLOP de computação teórica de IA em precisão FP4 com esparsidade.

A memória unificada é memória compartilhada do sistema, não VRAM dedicada. As especificações variam conforme a configuração; o desempenho teórico não garante velocidade dos aplicativos nem quantidade de usuários simultâneos.

O DGX Spark fornece o processamento. O Team AI Box adiciona uma interface comum para inferência local, geração de imagens, OCR, transcrição, tradução e colaboração. A primeira instalação a partir do código baixa as dependências e constrói o ambiente de execução antes da configuração.

[Especificações oficiais do NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

O Team AI Box é um projeto independente da Weerocks LLC, não um produto, certificação ou endosso da NVIDIA. O hardware compatível é definido nos requisitos de instalação abaixo.

<a id="install"></a>

## Instalar em um DGX Spark novo

Use um **DGX Spark sem instalação prévia, com Ubuntu 24.04 ARM64**, Docker Engine/Compose v2, drivers e contêineres NVIDIA funcionando, KVM, Git e Python 3.10+. Reserve centenas de GB temporários para modelos, builds e pacote. Não instale do zero sobre dados existentes.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Execute os comandos **no Spark**. O script baixa modelos e entradas, constrói imagens, prepara um pacote offline completo e instala. O primeiro build exige Internet e tempo; clonar não instala o produto. Reutiliza Docker/NVIDIA.

### Pré-verificação e retomada

`--check` verifica pré-requisitos. Após interrupção, preserve `/var/tmp/teamaibox-source-build` e repita **o mesmo comando** para reutilizar downloads verificados e etapas concluídas. Não apague o cache nem inicie builds concorrentes. O padrão usa fontes oficiais. Se inacessíveis, veja [o guia](install/SOURCE-INSTALL.pt-BR.md) para alternativas ou transferência de cache/pacote verificado; espelhos não têm disponibilidade garantida. Código alterado exige novo `--work-dir`, sem ignorar verificações.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Depois da instalação

1. Abra `https://<BOX_LAN_IP>/` no IP LAN atual e confirme que o certificado HTTPS local é do seu dispositivo.
2. Entre com `admin` / `admin`, **troque a senha inicial** e crie contas comuns. Não exponha essas credenciais na Internet.
3. Aguarde cada aplicativo ficar pronto e escolha idioma/tema no perfil.
4. Forneça ISOs ARM64 e licenças autorizadas de Windows/Linux. Para instalação offline, prepare primeiro o pacote completo e siga [o guia](install/README.pt-BR.md). A preparação do código é online.

## Licença e limites

Código próprio e documentação são MIT, **não todos os binários da instalação**. Terceiros, modelos, NVIDIA, firmware, Google e Windows mantêm seus termos. Git não inclui pesos, discos convidados instalados, sessões, ISOs ou pacotes. Compatibilidade Google não é certificação Play Protect; transmissão não cobre DRM nem certificação Apple. Não se declara suporte a Windows 10 ARM64. Desempenho e concorrência dependem da carga e do hardware.

<a id="contribute"></a>

## Construa com a gente

Recebemos relatos de bugs, documentação, traduções, acessibilidade, integrações e código. Explique o problema em uma issue, faça fork e uma branch focada e envie PR com verificações e capturas relevantes. Não precisa de Spark para documentação ou componentes isolados; informe os testes reais de hardware. Não publique segredos, arquivos pessoais ou imagens com login. Vulnerabilidades devem ser relatadas em privado conforme SECURITY.md. Sem CLA obrigatório ou autorização paga.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.pt-BR.md) · [SECURITY](SECURITY.pt-BR.md)

## Saiba mais

- [Instalação do código e recuperação](install/SOURCE-INSTALL.pt-BR.md)
- [Pacote offline](install/README.pt-BR.md)
- [Ambiente de desenvolvimento](docs/open-source/BUILDING.pt-BR.md)
- [Como contribuir](CONTRIBUTING.pt-BR.md)
- [Relato privado de segurança](SECURITY.pt-BR.md)
- [Licenças de terceiros e distribuição](THIRD_PARTY_NOTICES.pt-BR.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Licenças de terceiros e distribuição](docs/open-source/RELEASING.pt-BR.md)
