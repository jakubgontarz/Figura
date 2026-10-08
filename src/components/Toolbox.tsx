/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Paintbrush,
  Eraser,
  Blend,
  Palette,
  Stamp,
  Waves,
  Pipette,
  SquareDashed,
  CircleDashed,
  Lasso,
  Wand2,
  SquareDashedMousePointer,
  SquareMousePointer,
  PaintBucket,
  Rainbow,
  Shapes,
  Minus,
  Spline,
  Hand,
  ZoomIn,
  Type,
} from 'lucide-react';
import { ShapeKind, ToolType } from '../core/skia/types.ts';

interface ToolboxProps {
  activeTool: ToolType;
  onSelectTool: (tool: ToolType) => void;
  activeShapeType?: ShapeKind;
  onSelectShapeType?: (shape: ShapeKind) => void;
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
}) => {
  const tools: ToolDefinition[] = [
    {
      id: 'select-rect',
      name: 'Zaznaczenie prostokątne',
      shortcut: 'S',
      icon: <SquareDashed size={16} strokeWidth={2.2} />,
    },
    {
      id: 'select-ellipse',
      name: 'Zaznaczenie eliptyczne',
      shortcut: 'M',
      icon: <CircleDashed size={16} strokeWidth={2.2} />,
    },
    {
      id: 'select-lasso',
      name: 'Zaznaczanie odręczne',
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
      name: 'Przekształć zaznaczenie',
      shortcut: 'T',
      icon: <SquareDashedMousePointer size={16} strokeWidth={2.2} />,
    },
    {
      id: 'transform-content',
      name: 'Przekształć zawartość',
      shortcut: 'Ctrl+T',
      icon: <SquareMousePointer size={16} strokeWidth={2.2} />,
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
      id: 'correction-brush',
      name: 'Pędzel korekcyjny',
      shortcut: 'J',
      icon: <Blend size={16} strokeWidth={2.2} />,
    },
    {
      id: 'color-replace',
      name: 'Zmiana koloru',
      shortcut: 'R',
      icon: <Palette size={16} strokeWidth={2.2} />,
    },
    {
      id: 'stamp',
      name: 'Pieczątka (Klonowanie)',
      shortcut: 'C',
      icon: <Stamp size={16} strokeWidth={2.2} />,
    },
    {
      id: 'deform',
      name: 'Deformacja',
      shortcut: 'D',
      icon: <Waves size={16} strokeWidth={2.2} />,
    },
    {
      id: 'bucket',
      name: 'Wypełnienie',
      shortcut: 'F',
      icon: <PaintBucket size={16} strokeWidth={2.2} />,
    },
    {
      id: 'gradient',
      name: 'Gradient',
      shortcut: 'G',
      icon: <Rainbow size={16} strokeWidth={2.2} />,
    },
    {
      id: 'pipette',
      name: 'Pipeta',
      shortcut: 'K',
      icon: <Pipette size={16} strokeWidth={2.2} />,
    },
    {
      id: 'shapes',
      name: 'Kształty',
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
      id: 'bezier',
      name: 'Linia krzywa',
      shortcut: 'P',
      icon: <Spline size={16} strokeWidth={2.2} />,
    },
    {
      id: 'text',
      name: 'Tekst',
      shortcut: 'Y',
      icon: <Type size={16} strokeWidth={2.2} />,
    },
    {
      id: 'pan',
      name: 'Nawigacja',
      shortcut: 'H',
      icon: <Hand size={16} strokeWidth={2.2} />,
    },
    {
      id: 'zoom',
      name: 'Lupa',
      shortcut: 'Z',
      icon: <ZoomIn size={16} strokeWidth={2.2} />,
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
    </div>
  );
};
