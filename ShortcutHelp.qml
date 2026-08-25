import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: helpRoot

  signal closeRequested()

  property string fontFamily: Style.font.menuFamily
  property int captionSize: Style.space(12)
  property int headingSize: Style.space(15)

  readonly property var shortcuts: [
    { keys: "Type", action: "Filter files" },
    { keys: "Esc", action: "Clear filter / close finder" },
    { keys: "Ctrl+Backspace", action: "Delete last filter word" },
    { keys: "\u2191 / \u2193  or  Ctrl+J / Ctrl+K", action: "Move selection" },
    { keys: "PgUp / PgDn", action: "Jump six rows" },
    { keys: "Home / End", action: "First / last row" },
    { keys: "Enter", action: "Open selection" },
    { keys: "Shift+Enter", action: "Copy path" },
    { keys: "Alt+Enter", action: "Reveal in file manager" },
    { keys: "Del / Ctrl+D", action: "Move to trash" },
    { keys: "Ctrl+Shift+/", action: "Toggle this help" }
  ]

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: Color.menu.scrim

    MouseArea {
      anchors.fill: parent
      onClicked: helpRoot.closeRequested()
    }
  }

  BorderSurface {
    id: panel

    readonly property int gap: Style.space(12)

    anchors.centerIn: parent
    width: Math.min(Style.space(480), helpRoot.width - Style.space(56))
    height: Math.min(helpRoot.height - Style.space(56),
      padding * 2 + contentTopInset + contentBottomInset
      + heading.implicitHeight + gap + list.contentHeight + gap + hint.implicitHeight)
    radius: Style.cornerRadius
    color: Color.menu.background
    borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
    padding: Style.spacing.panelPadding

    Text {
      id: heading
      anchors.top: parent.top
      anchors.topMargin: panel.contentTopInset
      anchors.left: parent.left
      anchors.leftMargin: panel.contentLeftInset
      anchors.right: parent.right
      anchors.rightMargin: panel.contentRightInset
      text: "Keyboard shortcuts"
      textFormat: Text.PlainText
      color: Color.menu.text
      font.family: helpRoot.fontFamily
      font.pixelSize: helpRoot.headingSize
      elide: Text.ElideRight
    }

    ListView {
      id: list
      anchors.top: heading.bottom
      anchors.topMargin: panel.gap
      anchors.bottom: hint.top
      anchors.bottomMargin: panel.gap
      anchors.left: parent.left
      anchors.leftMargin: panel.contentLeftInset
      anchors.right: parent.right
      anchors.rightMargin: panel.contentRightInset
      model: helpRoot.shortcuts
      clip: true
      interactive: contentHeight > height
      boundsBehavior: Flickable.StopAtBounds
      spacing: Style.space(6)

      delegate: Item {
        id: row
        required property var modelData
        width: ListView.view.width
        height: Math.max(keyLabel.implicitHeight, actionLabel.implicitHeight)

        Text {
          id: keyLabel
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Math.min(implicitWidth, parent.width - Style.space(120))
          text: row.modelData.keys
          textFormat: Text.PlainText
          color: Color.menu.selectedBackground
          font.family: helpRoot.fontFamily
          font.pixelSize: helpRoot.captionSize
          elide: Text.ElideRight
        }

        Text {
          id: actionLabel
          anchors.left: keyLabel.right
          anchors.leftMargin: Style.space(16)
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: row.modelData.action
          textFormat: Text.PlainText
          color: Color.menu.text
          opacity: 0.62
          font.family: helpRoot.fontFamily
          font.pixelSize: helpRoot.captionSize
          elide: Text.ElideRight
        }
      }
    }

    Text {
      id: hint
      anchors.bottom: parent.bottom
      anchors.bottomMargin: panel.contentBottomInset
      anchors.left: parent.left
      anchors.leftMargin: panel.contentLeftInset
      anchors.right: parent.right
      anchors.rightMargin: panel.contentRightInset
      text: "Ctrl+Shift+/ closes"
      textFormat: Text.PlainText
      color: Color.menu.text
      opacity: 0.5
      font.family: helpRoot.fontFamily
      font.pixelSize: helpRoot.captionSize
    }
  }
}
