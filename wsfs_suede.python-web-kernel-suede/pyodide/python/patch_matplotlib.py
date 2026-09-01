import base64
import io
from PIL import Image

import matplotlib
matplotlib.use('Agg')

from matplotlib import pyplot as plt
import matplotlib.animation as animation

global FuncAnimation
FuncAnimation = animation.FuncAnimation

_animation_ref = None

def _emit_to_js(payload):
    emit = globals().get('__python_web_kernel_emit_matplotlib', None)
    if emit is None:
        return False
    emit(payload)
    return True

def ensure_matplotlib_patch():
    global FuncAnimation
    _old_show = plt.show
    old_FuncAnimation = FuncAnimation

    global _animation_ref
    global _total_frames
    total_frames = 0

    # Custom function to create and store animations
    def custom_FuncAnimation(*args, **kwargs):
        global _animation_ref
        global _total_frames

        frames = kwargs.get('frames', None)

        if isinstance(frames, int):
            _total_frames = frames
        elif hasattr(frames, '__len__'):
            _total_frames = len(frames)
        elif frames is not None:
            # Estimate frame count if it's a generator (iterate over it once to count)
            _total_frames = sum(1 for _ in frames)
        else:
            raise TypeError("Unable to determine the total number of frames")

        _animation_ref = old_FuncAnimation(*args, **kwargs)
        return _animation_ref

    # Override FuncAnimation to capture the animation reference
    animation.FuncAnimation = custom_FuncAnimation
    FuncAnimation = custom_FuncAnimation

    def show():
        fig = plt.gcf()
        buf = io.BytesIO()
        outformat = 'png'
        global _animation_ref
        if _animation_ref is not None:
            outformat = 'gif'
            frames = []
            for frame in range(_total_frames):  # Iterate over all frames
                _animation_ref._step()  # Advance to the next frame
                buf = io.BytesIO()
                fig.savefig(buf, format='png')  # Save current frame to buffer
                buf.seek(0)
                curr_img = Image.open(buf)
                frames.append(curr_img)  # Append frame as PIL Image
            gif_buf = io.BytesIO()
            frames[0].save(fp=gif_buf, format='GIF', save_all=True, append_images=frames[1:], loop=0)
            gif_buf.seek(0)
            data = base64.b64encode(gif_buf.read()).decode('utf-8')
            width, height = frames[0].size
        else:
            fig.savefig(buf, format='png')
            buf.seek(0)
            # encode to a base64 str
            data = base64.b64encode(buf.read()).decode('utf-8')
            width, height = fig.get_size_inches() * fig.dpi
            width, height = int(width), int(height)
        plt.close(fig)
        payload = {
            'base64': data,
            'width': width,
            'height': height,
            'format': outformat,
        }
        _animation_ref = None

        if _emit_to_js(payload):
            return None

        return payload

    plt.show = show

ensure_matplotlib_patch()