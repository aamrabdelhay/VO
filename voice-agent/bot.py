import os

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.groq.stt import GroqSTTService
from pipecat.services.groq.tts import GroqTTSService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.workers.runner import WorkerRunner

load_dotenv(override=True)

SYSTEM_INSTRUCTION = os.getenv(
    "GARVEX_REALTIME_SYSTEM_INSTRUCTION",
    """You are Garvex, the realtime voice agent inside VO.
Speak naturally, briefly, and clearly. You are allowed to inspect and explain information, but do not claim that a project was changed, deployed, deleted, or otherwise mutated unless VO has explicitly executed the corresponding Build & Fix operation.
This realtime voice channel is read-only by default. When the user asks for an actual code change, ask them to use Build & Fix in VO unless this session is explicitly wired to a mutating tool.
Avoid markdown, bullets, emojis, and long monologues because your response is spoken aloud.""",
)

transport_params = {
    "daily": lambda: DailyParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        vad_analyzer=SileroVADAnalyzer(),
    ),
    "webrtc": lambda: TransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        vad_analyzer=SileroVADAnalyzer(),
    ),
}


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    groq_key = os.environ["GROQ_API_KEY"]

    stt = GroqSTTService(
        api_key=groq_key,
        settings=GroqSTTService.Settings(language=None),
    )
    llm = GroqLLMService(
        api_key=groq_key,
        settings=GroqLLMService.Settings(
            model=os.getenv("GARVEX_REALTIME_LLM_MODEL", "openai/gpt-oss-120b"),
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.2,
            top_p=1.0,
            max_completion_tokens=700,
        ),
    )
    tts = GroqTTSService(api_key=groq_key)

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport: BaseTransport, client):
        logger.info("Garvex realtime client connected")
        context.add_message(
            {
                "role": "developer",
                "content": "Greet the user naturally in one short sentence and wait for their first request.",
            }
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport: BaseTransport, client):
        logger.info("Garvex realtime client disconnected")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments):
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
