/* global document */
import GL from '@luma.gl/constants';
import {Texture2D, copyToImage} from 'luma.gl';
import {loadImage} from '@loaders.gl/core';
// TODO LRUCache will be moved to @luma.gl/text module in v7.0
import LRUCache from '../text-layer/lru-cache';

const MAX_CANVAS_WIDTH = 1024;
const DEFAULT_BUFFER = 4;

const DEFAULT_TEXTURE_MIN_FILTER = GL.LINEAR_MIPMAP_LINEAR;
// GL.LINEAR is the default value but explicitly set it here
const DEFAULT_TEXTURE_MAG_FILTER = GL.LINEAR;

const noop = () => {};

/**
 * {
 *   [gl]: {
 *     texture, // Texture2D instance containing the icons
 *     mapping, // Object, {[id]: {width, height, }}
 *     xOffset, // right position of last icon
 *     yOffset, // top position of last icon
 *     canvasHeight // canvas height
 *   }
 * }
 */
const cached = new LRUCache(3);

function nextPowOfTwo(number) {
  return Math.pow(2, Math.ceil(Math.log2(number)));
}

// resize image to given width and height
function resizeImage(ctx, imageData, width, height) {
  const {naturalWidth, naturalHeight} = imageData;
  if (width === naturalWidth && height === naturalHeight) {
    return imageData;
  }

  ctx.canvas.height = height;
  ctx.canvas.width = width;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight
  ctx.drawImage(imageData, 0, 0, naturalWidth, naturalHeight, 0, 0, width, height);

  return ctx.canvas;
}

function getIconId(icon) {
  return icon && (icon.id || icon.url);
}

// traverse icons in a row of icon atlas
// extend each icon with left-top coordinates
function buildRowMapping(mapping, columns, yOffset) {
  for (let i = 0; i < columns.length; i++) {
    const {icon, xOffset} = columns[i];
    const id = getIconId(icon);
    mapping[id] = Object.assign({}, icon, {
      x: xOffset,
      y: yOffset
    });
  }
}

/**
 * Generate coordinate mapping to retrieve icon left-top position from an icon atlas
 * @param icons {Array<Object>} list of icons, each icon requires url, width, height
 * @param buffer {Number} add buffer to the right and bottom side of the image
 * @param xOffset {Number} right position of last icon in old mapping
 * @param yOffset {Number} top position in last icon in old mapping
 * @param maxCanvasWidth {Number} max width of canvas
 * @param mapping {object} old mapping
 * @returns {{mapping: {'/icon/1': {url, width, height, ...}},, canvasHeight: {Number}}}
 */
export function buildMapping({
  icons,
  buffer,
  mapping = {},
  xOffset = 0,
  yOffset = 0,
  maxCanvasWidth
}) {
  // height of current row
  let rowHeight = 0;

  let columns = [];
  // Strategy to layout all the icons into a texture:
  // traverse the icons sequentially, layout the icons from left to right, top to bottom
  // when the sum of the icons width is equal or larger than maxCanvasWidth,
  // move to next row starting from total height so far plus max height of the icons in previous row
  // row width is equal to maxCanvasWidth
  // row height is decided by the max height of the icons in that row
  // mapping coordinates of each icon is its left-top position in the texture
  for (let i = 0; i < icons.length; i++) {
    const icon = icons[i];
    const {height, width} = icon;

    // fill one row
    if (xOffset + width + buffer > maxCanvasWidth) {
      buildRowMapping(mapping, columns, yOffset);

      xOffset = 0;
      yOffset = rowHeight + yOffset + buffer;
      rowHeight = 0;
      columns = [];
    }

    columns.push({
      icon,
      xOffset
    });

    xOffset = xOffset + width + buffer;
    rowHeight = Math.max(rowHeight, height);
  }

  if (columns.length > 0) {
    buildRowMapping(mapping, columns, yOffset);
  }

  const canvasHeight = nextPowOfTwo(rowHeight + yOffset + buffer);

  return {
    mapping,
    xOffset,
    yOffset,
    canvasWidth: maxCanvasWidth,
    canvasHeight
  };
}

// extract icons from data
// return icons should be unique, not cached, cached but url changed
function getDiffIcons(data, getIcon, cachedIcons) {
  if (!data || !getIcon) {
    return null;
  }

  const icons = {};
  for (const point of data) {
    const icon = getIcon(point);
    const id = getIconId(icon);

    if (!icon) {
      throw new Error('Icon is missing.');
    }

    if (!icon.url) {
      throw new Error('Icon url is missing.');
    }

    if (!icons[id] || !cachedIcons[id] || !icon.url !== cachedIcons[id].url) {
      icons[id] = icon;
    }
  }

  return icons;
}

export default class IconManager {
  constructor(
    gl,
    {
      onUpdate = noop // notify IconLayer when icon texture update
    }
  ) {
    this.gl = gl;
    this.onUpdate = onUpdate;

    this._getIcon = null;

    cached.set(gl, {
      mapping: {},
      xOffset: 0,
      yOffset: 0,
      canvasWidth: 0,
      canvasHeight: 0
    });

    this._texture = null;
    this._mapping = null;
    this._autoPacking = false;

    this._canvas = null;
  }

  getTexture() {
    // if (this._autoPacking) {
    //
    // }
    //
    // return this._texture;
    return this._autoPacking ? cached.get(this.gl).texture : this._texture;
  }

  getIconMapping(dataPoint) {
    const icon = this._getIcon(dataPoint);

    if (this._autoPacking) {
      const id = getIconId(icon);
      const mapping = cached.get(this.gl).mapping;
      return mapping[id] || {};
    }

    return this._mapping[icon] || {};
  }

  setProps({autoPacking, iconAtlas, iconMapping, data, getIcon}) {
    if (autoPacking !== undefined) {
      this._autoPacking = autoPacking;
    }

    if (getIcon) {
      this._getIcon = getIcon;
    }

    if (iconMapping) {
      this._mapping = iconMapping;
    }

    if (iconAtlas) {
      this._updateIconAtlas(iconAtlas);
    }

    if (this._autoPacking && (data || getIcon)) {
      this._canvas = this._canvas || document.createElement('canvas');

      this._updateAutoPacking({
        data,
        buffer: DEFAULT_BUFFER,
        maxCanvasWidth: MAX_CANVAS_WIDTH
      });
    }
  }

  _updateIconAtlas(iconAtlas) {
    if (iconAtlas instanceof Texture2D) {
      iconAtlas.setParameters({
        [GL.TEXTURE_MIN_FILTER]: DEFAULT_TEXTURE_MIN_FILTER,
        [GL.TEXTURE_MAG_FILTER]: DEFAULT_TEXTURE_MAG_FILTER
      });

      this._texture = iconAtlas;
      this.onUpdate();
    } else if (typeof iconAtlas === 'string') {
      loadImage(iconAtlas).then(data => {
        this._texture = new Texture2D(this.gl, {
          data,
          parameters: {
            [GL.TEXTURE_MIN_FILTER]: DEFAULT_TEXTURE_MIN_FILTER,
            [GL.TEXTURE_MAG_FILTER]: DEFAULT_TEXTURE_MAG_FILTER
          }
        });
        this.onUpdate();
      });
    }
  }

  _updateAutoPacking({data, buffer, maxCanvasWidth}) {
    const cachedData = cached.get(this.gl) || {};
    const icons = Object.values(getDiffIcons(data, this._getIcon, cachedData.mapping) || {});

    if (icons.length > 0) {
      // generate icon mapping
      const {mapping, xOffset, yOffset, canvasHeight} = buildMapping({
        icons,
        buffer,
        maxCanvasWidth,
        mapping: cachedData.mapping,
        xOffset: cachedData.xOffset,
        yOffset: cachedData.yOffset
      });

      // create new texture
      let texture = cachedData.texture;
      if (!texture) {
        texture = new Texture2D(this.gl, {
          width: maxCanvasWidth,
          height: canvasHeight
        });
      }

      if (texture.height !== canvasHeight) {
        this._resizeTexture(texture, texture.width, canvasHeight);
      }

      cached.set(this.gl, {
        mapping,
        texture,
        xOffset,
        yOffset,
        canvasHeight
      });

      this.onUpdate();

      // load images
      this._loadIcons(icons, texture);
    }
  }

  // resize texture without losing original data
  _resizeTexture(texture, width, height) {
    const oldWidth = texture.width;
    const oldHeight = texture.height;
    const oldPixels = copyToImage(texture);

    texture.resize({width, height});

    texture.setSubImageData({
      data: oldPixels,
      x: 0,
      y: height - oldHeight,
      width: oldWidth,
      height: oldHeight,
      parameters: {
        [GL.TEXTURE_MIN_FILTER]: DEFAULT_TEXTURE_MIN_FILTER,
        [GL.TEXTURE_MAG_FILTER]: DEFAULT_TEXTURE_MAG_FILTER,
        [GL.UNPACK_FLIP_Y_WEBGL]: true
      }
    });
    texture.generateMipmap();

    return texture;
  }

  _loadIcons(icons, texture) {
    const ctx = this._canvas.getContext('2d');
    const canvasHeight = texture.height;

    for (const icon of icons) {
      loadImage(icon.url).then(imageData => {
        const id = getIconId(icon);
        const {x, y, width, height} = cached.get(this.gl).mapping[id];

        const data = resizeImage(ctx, imageData, width, height);

        texture.setSubImageData({
          data,
          x,
          y: canvasHeight - y - height, // flip Y as texture stored as reversed Y
          width,
          height,
          parameters: {
            [GL.TEXTURE_MIN_FILTER]: DEFAULT_TEXTURE_MIN_FILTER,
            [GL.TEXTURE_MAG_FILTER]: DEFAULT_TEXTURE_MAG_FILTER,
            [GL.UNPACK_FLIP_Y_WEBGL]: true
          }
        });

        // Call to regenerate mipmaps after modifying texture(s)
        texture.generateMipmap();

        this.onUpdate();
      });
    }
  }
}
