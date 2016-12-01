/*
*   Copyright (C) 2013-2014 Spark Labs, Inc. All rights reserved. -  https://www.spark.io/
*
*   This file is part of the Spark-protocol module
*
*   This program is free software: you can redistribute it and/or modify
*   it under the terms of the GNU General Public License version 3
*   as published by the Free Software Foundation.
*
*   Spark-protocol is distributed in the hope that it will be useful,
*   but WITHOUT ANY WARRANTY; without even the implied warranty of
*   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
*   GNU General Public License for more details.
*
*   You should have received a copy of the GNU General Public License
*   along with Spark-protocol.  If not, see <http://www.gnu.org/licenses/>.
*
*   You can download the source here: https://github.com/spark/spark-protocol
*
* @flow
*
*/

import type {MessageSpecificationType} from './MessageSpecifications';

var fs = require('fs');
var settings = require('../settings');
var Message = require('h5.coap').Message;
var Option = require('h5.coap/lib/Option.js');
var logger = require('../lib/logger.js');

import {BufferBuilder, BufferReader} from 'h5.buffers';
import MessageSpecifications from './MessageSpecifications';

/**
 * Interface for the Spark Core Messages
 * @constructor
 */

const _getRouteKey = (code: string, path: string): string => {
  var uri = code + path;

  //find the slash.
  var idx = uri.indexOf('/');

  //this assumes all the messages are one character for now.
  //if we wanted to change this, we'd need to find the first non message char, '/' or '?',
  //or use the real coap parsing stuff
  return uri.substr(0, idx + 2);
}

class Messages {
  _specifications: Map<string, MessageSpecificationType> =
    new Map(MessageSpecifications);

  /**
   * Maps CODE + URL to MessageNames as they appear in 'Spec'
   */
  _routes: Map<string, string> = new Map(
    MessageSpecifications
      .filter(([name, value]) => value.uri)
      .map(([name, value]) => {
        //see what it looks like without params
        const uri = value.template ? value.template.render({}) : value.uri;
        const routeKey = _getRouteKey(value.code, '/' + (uri || ''));

        return [routeKey, name];
      },
    ),
  );

  /**
   * does the special URL writing needed directly to the COAP message object,
   * since the URI requires non-text values
   *
   * @param showSignal
   * @returns {Function}
   */
  raiseYourHandUrlGenerator = (
    showSignal: boolean,
  ): (message: Message) => Buffer => {
    return (message: Message): Buffer => {
      const buffer = new Buffer(1);
      buffer.writeUInt8(showSignal ? 1 : 0, 0);

      message.addOption(new Option(Message.Option.URI_PATH, new Buffer('s')));
      message.addOption(new Option(Message.Option.URI_QUERY, buffer));
      return message;
    };
  };

  getRouteKey = _getRouteKey;

  getRequestType = (message: Message): ?string => {
    const uri = this.getRouteKey(message.getCode(), message.getUriPath());
    return this._routes.get(uri);
  };

  getResponseType = (name: string): ?string => {
    const specification = this._specifications.get(name);
    return specification ? specification.Response : null;
  };

  statusIsOkay = (message: Message): boolean => {
      return message.getCode() < Message.Code.BAD_REQUEST;
  };

  /**
   *
   * @param name
   * @param id - must be an unsigned 16 bit integer
   * @param params
   * @param data
   * @param token - helps us associate responses w/ requests
   * @param onError
   * @returns {*}
   */
  wrap = (
    specificationName: string,
    messageCounterId: number,
    params: Object,
    data: Buffer,
    token?: number,
    onError?: Function,
  ): ?Buffer => {
      var specification = this._specifications.get(specificationName);
      if (!specification) {
        onError && onError('Unknown Message Type');
        return null;
      }

      // Setup the Message
      let message = new Message();

      // Format our url
      let uri = specification.uri;
      if (params && params._writeCoapUri) {
        // for our messages that have nitty gritty urls that require raw bytes
        // and no strings.
        message = params._writeCoapUri(message);
        uri = null;
      } else if (params && specification.template) {
        uri = specification.template.render(params);
      }

      if (uri) {
        message.setUri(uri);
      }

      message.setId(messageCounterId);

      if (token !== null && token !== undefined) {
        const buffer = new Buffer(1);
        buffer.writeUInt8(token, 0);
        message.setToken(buffer);
      }

      message.setCode(specification.code);
      message.setType(specification.type);

      // Set our payload
      if (data) {
        message.setPayload(data);
      }

      if (params && params._raw) {
        params._raw(message);
      }

      return message.toBuffer();
  };

  unwrap = (data: Buffer): ?Message => {
    if (!data) {
      return null;
    }

    try {
      return Message.fromBuffer(data);
    } catch (exception) {
      logger.error('Coap Error: ' + exception);
    }

    return null;
  };


  //http://en.wikipedia.org/wiki/X.690
  //=== TYPES: SUBSET OF ASN.1 TAGS ===
  //
  //1: BOOLEAN (false=0, true=1)
  //2: INTEGER (int32)
  //4: OCTET STRING (arbitrary bytes)
  //5: NULL (void for return value only)
  //9: REAL (double)

  /**
   * Translates the integer variable type enum to user friendly string types
   * @param varState
   * @returns {*}
   * @constructor
   */
  translateIntTypes = (varState: ?Object): ?Object => {
    if (!varState) {
        return null;
    }

    for (var varName in varState) {
      if (!varState.hasOwnProperty(varName)) {
        continue;
      }

      const intType = varState[varName];
      if (typeof intType === 'number') {
        const str = this.getNameFromTypeInt(intType);

        if (str != null) {
          varState[varName] = str;
        }
      }
    }

    return varState;
  };

  getNameFromTypeInt = (typeInt: number): string => {
    switch (typeInt) {
      case 1: {
        return 'bool';
      }

      case 2: {
        return 'int32';
      }

      case 4: {
        return 'string';
      }

      case 5: {
        return 'null';
      }

      case 9: {
        return 'double';
      }

      default: {
        logger.error('asked for unknown type: ' + typeInt);
        throw 'errror getNameFromTypeInt ' + typeInt;
      }
    }
  };

  tryfromBinary = (buffer: Buffer, typeName: string): any => {
      var result = null;
      try {
        result = this.fromBinary(buffer, typeName);
      } catch (exception) {
        logger.error('Could not parse type: ${typeName} ${buffer}', exception);
      }
      return result;
  };

  fromBinary = (buffer: Buffer, typeName: string): any => {
    //logger.log('converting a ' + name + ' fromBinary input was ' + buf);

    if (!Buffer.isBuffer(buffer)) {
        buffer = new Buffer(buffer);
    }

    var newBuffer = new BufferReader(buffer);

    switch (typeName) {
      case 'bool': {
        return newBuffer.shiftByte() != 0;
      }

      case 'crc': {
        return newBuffer.shiftUInt32();
      }

      case 'uint32': {
        return newBuffer.shiftUInt32();
      }

      case 'uint16': {
        return newBuffer.shiftUInt16();
      }

      case 'int32':
      case 'number': {
        return newBuffer.shiftInt32();
      }

      case 'float': {
        return newBuffer.shiftFloat();
      }

      case 'double': {
        //doubles on the core are little-endian
        return newBuffer.shiftDouble(true);
      }

      case 'buffer': {
        return buffer;
      }

      case 'string':
      default: {
        return buffer.toString();
      }
    }
  };

  toBinary = (
    value: string | number | Buffer,
    typeName?: string,
    bufferBuilder?: BufferBuilder,
  ): Buffer => {
    typeName = typeName || (typeof value);

    bufferBuilder = bufferBuilder || new BufferBuilder();

    switch (typeName) {
      case 'uint32':
      case 'crc': {
        bufferBuilder.pushUInt32(value);
        break;
      }

      case 'int32': {
        bufferBuilder.pushInt32(value);
        break;
      }

      case 'number':
      case 'double': {
        bufferBuilder.pushDouble(value);
        break;
      }

      case 'buffer': {
        bufferBuilder.pushBuffer(value);
        break;
      }

      case 'string':
      default: {
        bufferBuilder.pushString(value || '');
        break;
      }
    }

    return bufferBuilder.toBuffer();
  };

  buildArguments = (value: Object, args: Array<Object>): ?Buffer => {
    console.log('TODO: Type `buildArguments`');
    try {
      var bufferBuilder = new BufferBuilder();
      args.filter(arg => arg).forEach((arg, index) => {
        if (index > 0) {
          this.toBinary('&', 'string', bufferBuilder);
        }

        const name = arg[0] || Object.keys(value)[0];
        const type = arg[1];
        const val = value[name];

        this.toBinary(val, type, bufferBuilder);
      })
      return bufferBuilder.toBuffer();
    } catch (exception) {
      logger.error('buildArguments: ', exception);
    }


    return null;
  };

  parseArguments = (args: Object, desc: Array<Object>): ?Array<any> => {
    console.log('TODO: Type `parseArguments`');
    try {
      if (!args || (args.length != desc.length)) {
          return null;
      }

      var results = [];
      for (var i = 0; i < desc.length; i++) {
        var p = desc[i];
        if (!p) {
            continue;
        }

        //desc -> [ [ name, type ], ... ]
        var type = p[1];
        var val = (i < args.length) ? args[i] : '';

        results.push(
          this.fromBinary(new Buffer(val, 'binary'), type)
        );
      }

      return results;
    } catch (exception) {
      logger.error('parseArguments: ', exception);
    }

    return null;
  };
}

export default new Messages();