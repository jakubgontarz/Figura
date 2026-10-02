/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Paintbrush,
  Eraser,
  Pipette,
  Crop,
  Circle,
  Lasso,
  Wand2,
  Scaling,
  Move,
  PaintBucket,
  Blend,
  Shapes,
  Minus,
  Hand,
} from 'lucide-react';
import { ToolType } from '../core/skia/types.ts';

interface ToolboxProps {
  activeTool: ToolType;
  onSelectTool: (tool: ToolType) => void;
  activeShapeType: 'rect' | 'ellipse' | 'line';
  onSelectShapeType: (shape: 'rect' | 'ellipse' | 'line') => void;
}

interface ToolDefinition {
  id: ToolType;
  name: string;
  shortcut: string;
  icon: React.ReactNode;
}

export const Toolbox: React.FC<ToolboxProps> = ({
  activeTool,
  onSelectTool,
  activeShapeType,
  onSelectShapeType,
}) => {
  const tools: ToolDefinition[] = [
    {
      id: 'select-rect',
      name: 'Zaznaczenie prostokątne',
      shortcut: 'S',
      icon: <Crop size={16} strokeWidth={2.2} />,
    },
    {
      id: 'select-ellipse',
      name: 'Zaznaczenie eliptyczne',
      shortcut: 'M',
      icon: <Circle size={16} strokeWidth={2.2} />,
    },
    {
      id: 'select-lasso',
      name: 'Lasso (Zaznaczanie odręczne)',
      shortcut: 'L',
      icon: <Lasso size={16} strokeWidth={2.2} />,
    },
    {
      id: 'magic-wand',
      name: 'Magiczna różdżka',
      shortcut: 'W',
      icon: <Wand2 size={16} strokeWidth={2.2} />,
    },
    {
      id: 'transform-selection',
      name: 'Przekształć zaznaczenie (sama ramka)',
      shortcut: 'T',
      icon: <Scaling size={16} strokeWidth={2.2} />,
    },
    {
      id: 'transform-content',
      name: 'Przekształć zawartość (piksele warstwy)',
      shortcut: 'Ctrl+T',
      icon: <Move size={16} strokeWidth={2.2} />,
    },
    {
      id: 'brush',
      name: 'Pędzel',
      shortcut: 'B',
      icon: <Paintbrush size={16} strokeWidth={2.2} />,
    },
    {
      id: 'eraser',
      name: 'Gumka',
      shortcut: 'E',
      icon: <Eraser size={16} strokeWidth={2.2} />,
    },
    {
      id: 'bucket',
      name: 'Wiadro z farbą (Wypełnienie)',
      shortcut: 'F',
      icon: <PaintBucket size={16} strokeWidth={2.2} />,
    },
    {
      id: 'gradient',
      name: 'Wypełnienie gradientowe',
      shortcut: 'G',
      icon: <Blend size={16} strokeWidth={2.2} />,
    },
    {
      id: 'pipette',
      name: 'Pipeta (Próbnik koloru)',
      shortcut: 'K',
      icon: <Pipette size={16} strokeWidth={2.2} />,
    },
    {
      id: 'shapes',
      name: 'Kształty geometryczne',
      shortcut: 'O',
      icon: <Shapes size={16} strokeWidth={2.2} />,
    },
    {
      id: 'line',
      name: 'Linia prosta',
      shortcut: 'U',
      icon: <Minus size={16} strokeWidth={2.5} className="rotate-45" />,
    },
    {
      id: 'pan',
      name: 'Rączka (Przesuwanie widoku)',
      shortcut: 'H',
      icon: <Hand size={16} strokeWidth={2.2} />,
    },
  ];

  return (
    <div className="w-12 bg-[#252526] border-r border-[#1a1a1a] p-1.5 flex flex-col items-center gap-1 z-10 select-none shadow-md flex-shrink-0">
      {tools.map((tool) => {
        const isActive = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            onClick={() => onSelectTool(tool.id)}
            title={`${tool.name} (${tool.shortcut})`}
            className={`w-9 h-9 rounded flex items-center justify-center transition-all cursor-pointer ${
              isActive
                ? 'bg-[#094771] border border-[#007acc] text-white shadow'
                : 'text-[#bbbbbb] hover:bg-[#333333] hover:text-white border border-transparent'
            }`}
          >
            {tool.icon}
          </button>
        );
      })}

      {/* Podmenu wyboru kształtu, gdy narzędzie Shapes jest aktywne */}
      {activeTool === 'shapes' && (
        <div className="w-full mt-2 pt-2 border-t border-[#3a3a3a] flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => onSelectShapeType('rect')}
            title="Prostokąt"
            className={`w-7 h-7 rounded flex items-center justify-center cursor-pointer ${
              activeShapeType === 'rect' ? 'bg-[#007acc] text-white' : 'text-[#888] hover:bg-[#333]'
            }`}
          >
            <div className="w-3.5 h-3 border border-current" />
          </button>
          <button
            type="button"
            onClick={() => onSelectShapeType('ellipse')}
            title="Elipsa"
            className={`w-7 h-7 rounded flex items-center justify-center cursor-pointer ${
              activeShapeType === 'ellipse' ? 'bg-[#007acc] text-white' : 'text-[#888] hover:bg-[#333]'
            }`}
          >
            <div className="w-3.5 h-3.5 border border-current rounded-full" />
          </button>
        </div>
      )}
    </div>
  );
};
